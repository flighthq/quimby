import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { renderAgentScript, renderAgentScriptCmd } from './agentScript'

// The producer/consumer contract: agent.sh is the *producer* of these formats and the host
// is the *parser*. These regexes are copied verbatim from the host's canonical parsers so this test
// pins the shell output to what the host actually reads:
//   - attest block: `packages/agent/src/attestation.ts` (ATTEST_BLOCK + field regex)
//   - `attach:` frontmatter: `packages/handoff/src/outbox.ts` (parseDraft)
// When @quimbyhq/attest and @quimbyhq/parcel are extracted to leaves, this test imports them
// directly instead of copying.
const ATTEST_BLOCK = /```quimby-attest[ \t]*\n([\s\S]*?)```/g
const ATTEST_FIELD = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/

function parseAttestation(statusText: string): Record<string, string> | null {
  let body: string | undefined
  for (const m of statusText.matchAll(ATTEST_BLOCK)) body = m[1]
  if (body === undefined) return null
  const fields: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const m = ATTEST_FIELD.exec(line)
    if (m) fields[m[1].toLowerCase()] = m[2]
  }
  const result = fields.result?.split(/\s+/)[0]
  if (!fields.command || (result !== 'pass' && result !== 'fail')) return null
  return fields
}

function parseAttach(readme: string): { note: string; attach?: string } {
  if (!readme.startsWith('---')) return { note: readme }
  const end = readme.indexOf('\n---', 3)
  if (end === -1) return { note: readme }
  const frontmatter = readme.slice(3, end)
  const note = readme.slice(end + 4).replace(/^\r?\n/, '')
  const match = frontmatter.match(/^\s*attach:\s*(\S+)\s*$/m)
  return match ? { note, attach: match[1] } : { note }
}

const dirs: string[] = []

function makeAgentWorkspace(graph?: {
  roster?: readonly string[]
  escalatesTo?: readonly string[]
  directs?: readonly string[]
  directedBy?: readonly string[]
}): string {
  const root = mkdtempSync(join(tmpdir(), 'qa-'))
  dirs.push(root)
  mkdirSync(join(root, 'handoff', 'in', 'received'), { recursive: true })
  mkdirSync(join(root, 'status'), { recursive: true })
  writeFileSync(join(root, 'assignment.md'), '')
  writeFileSync(join(root, 'status.md'), 'idle\n')
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  }
  execFileSync('git', ['init', '-q'], { cwd: repo, env: gitEnv })
  writeFileSync(join(repo, 'f.txt'), 'x')
  execFileSync('git', ['add', '.'], { cwd: repo, env: gitEnv })
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo, env: gitEnv })
  const shPath = join(root, 'agent.sh')
  writeFileSync(shPath, renderAgentScript(graph ?? {}), { mode: 0o755 })
  return root
}

function runSh(root: string, args: string[], cwd = root, env?: Record<string, string>): string {
  return execFileSync('sh', [join(root, 'agent.sh'), ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
}

// The script exits non-zero on a refusal, so capture stderr instead of letting execFileSync throw.
function runShFail(root: string, args: string[]): { status: number; stderr: string } {
  try {
    execFileSync('sh', [join(root, 'agent.sh'), ...args], {
      cwd: root,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
  } catch (err) {
    const e = err as { status?: number; stderr?: string }
    return { status: e.status ?? -1, stderr: e.stderr ?? '' }
  }
  return { status: 0, stderr: '' }
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      execFileSync('rm', ['-rf', d])
    } catch {
      /* best-effort temp cleanup */
    }
  }
})

// Move the delivered base ahead of the agent, as `quimby sync` now does: land a commit and point
// `quimby/base` at it WITHOUT touching HEAD, the index, or the working tree.
function deliverBase(root: string, content = 'peer-landed'): string {
  const repo = join(root, 'repo')
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  }
  // agent.sh shells out to `git rebase`, which needs a committer identity in the repo itself —
  // the env-var identity above only covers the commits this helper makes. A real agent clone has
  // this configured by quimby's provisioning.
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
  execFileSync('git', ['checkout', '-q', '--detach'], { cwd: repo, env })
  writeFileSync(join(repo, 'shared.txt'), content)
  execFileSync('git', ['add', '.'], { cwd: repo, env })
  execFileSync('git', ['commit', '-q', '-m', 'peer work'], { cwd: repo, env })
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
  execFileSync('git', ['tag', '-f', 'quimby/base', base], { cwd: repo, env })
  execFileSync('git', ['checkout', '-q', head], { cwd: repo, env })
  execFileSync('git', ['checkout', '-q', '-B', 'main', head], { cwd: repo, env })
  return base
}

function gitIn(root: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: join(root, 'repo'), encoding: 'utf-8' }).trim()
}

describe('renderAgentScript', () => {
  // The delivery signal. The host no longer rebases the agent underneath its own edits, so this
  // footer is the ONLY thing that tells an agent its floor moved — it has to ride every command
  // and stay silent otherwise, or it becomes noise people learn to skip.
  it('says nothing about the base when the agent is current', () => {
    const root = makeAgentWorkspace()
    execFileSync('git', ['tag', 'quimby/base'], { cwd: join(root, 'repo') })
    expect(runSh(root, ['status'])).not.toContain('quimby/base')
  })

  it('reports a moved base after every command, not just a dedicated one', () => {
    const root = makeAgentWorkspace()
    deliverBase(root)
    // `status` is an ordinary, unrelated command — that is the point: the notice rides whatever
    // the agent happened to run. It goes to stderr so piped stdout stays parseable.
    const merged = execFileSync('sh', ['-c', `sh ${join(root, 'agent.sh')} status 2>&1`], {
      cwd: root,
      encoding: 'utf-8',
    })
    expect(merged).toContain('quimby/base is 1 commit(s) ahead')
    expect(merged).toContain('./agent.sh rebase')
  })

  it('refuses to rebase over a dirty tree — the resurrection this split exists to prevent', () => {
    const root = makeAgentWorkspace()
    deliverBase(root)
    writeFileSync(join(root, 'repo', 'in-flight.txt'), 'half a thought')
    const { status, stderr } = runShFail(root, ['rebase'])
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/tree is dirty/)
    // and it really did not touch anything
    expect(gitIn(root, ['status', '--porcelain'])).toContain('in-flight.txt')
  })

  it('applies the delivered base and keeps the peer work the agent replays onto', () => {
    const root = makeAgentWorkspace()
    const base = deliverBase(root, 'peer-landed')
    writeFileSync(join(root, 'repo', 'mine.txt'), 'my feature')
    execFileSync('git', ['add', '.'], { cwd: join(root, 'repo') })
    execFileSync('git', ['commit', '-q', '-m', 'my work'], {
      cwd: join(root, 'repo'),
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })

    expect(runSh(root, ['rebase'])).toContain('rebased onto quimby/base')

    // the peer's file is present at the delivered content (not reverted), with the agent's commit
    // replayed on top of it
    expect(readFileSync(join(root, 'repo', 'shared.txt'), 'utf-8')).toBe('peer-landed')
    expect(gitIn(root, ['log', '-1', '--format=%s'])).toBe('my work')
    expect(gitIn(root, ['merge-base', '--is-ancestor', base, 'HEAD']) === '').toBe(true)
  })

  it('is a no-op that says so when already on the delivered base', () => {
    const root = makeAgentWorkspace()
    execFileSync('git', ['tag', 'quimby/base'], { cwd: join(root, 'repo') })
    expect(runSh(root, ['rebase'])).toContain('already up to date')
  })

  it('annotates peers with their edge, so the roster is not a flat list to infer rank from', () => {
    const root = makeAgentWorkspace({
      roster: ['manager', 'integration', 'critic'],
      directs: ['integration'],
      escalatesTo: ['manager'],
      directedBy: ['manager'],
    })
    for (const peer of ['manager', 'integration', 'critic']) {
      writeFileSync(join(root, 'status', `${peer}.md`), 'idle\n')
    }
    const out = runSh(root, ['peers'])
    expect(out).toMatch(/manager\s+\(directs you/)
    expect(out).toMatch(/integration\s+\(you direct/)
    // A peer holding no edge is listed plainly — no invented rank.
    // an unannotated peer still lists, now carrying its mirror provenance
    expect(out).toMatch(/^critic\s+\[/m)
  })

  it('refuses a recipient that is not on the roster, and names the roster', () => {
    const root = makeAgentWorkspace({ roster: ['builder-2', 'manager'] })
    const { status, stderr } = runShFail(root, ['handoff', 'review', '-m', 'take a look'])
    expect(status).toBe(1)
    expect(stderr).toContain('"review" is not an agent')
    expect(stderr).toContain('builder-2 manager')
    // Nothing was queued — the point is that it never becomes a parcel that bounces host-side.
    expect(existsSync(join(root, 'handoff', 'out', 'queued', 'review'))).toBe(false)
  })

  it('refuses an --attach naming no agent (a bad attach retries host-side forever)', () => {
    const root = makeAgentWorkspace({ roster: ['builder-2', 'manager'] })
    const { status, stderr } = runShFail(root, [
      'handoff',
      'manager',
      '-m',
      'ship it',
      '--attach',
      'review',
    ])
    expect(status).toBe(1)
    expect(stderr).toContain('--attach "review" is not an agent')
  })

  it('refuses an escalation to a permitted-set outsider, and names the permitted set', () => {
    const root = makeAgentWorkspace({
      roster: ['manager', 'integration'],
      escalatesTo: ['manager'],
    })
    const { status, stderr } = runShFail(root, ['escalate', 'integration', '-m', 'blocked'])
    expect(status).toBe(1)
    expect(stderr).toContain('may not escalate to "integration"')
    expect(stderr).toContain('permitted: manager')
  })

  it('refuses any escalation when the agent has no escalation target at all', () => {
    const root = makeAgentWorkspace({ roster: ['manager'] })
    const { status, stderr } = runShFail(root, ['escalate', 'manager', '-m', 'blocked'])
    expect(status).toBe(1)
    expect(stderr).toContain('you have no escalation target')
  })

  it('allows a roster recipient and a permitted escalation target', () => {
    const root = makeAgentWorkspace({
      roster: ['manager', 'integration'],
      escalatesTo: ['manager'],
    })
    expect(runSh(root, ['handoff', 'integration', '-m', 'fyi'])).toContain('queued parcel')
    expect(runSh(root, ['escalate', 'manager', '-m', 'blocked'])).toContain('queued parcel')
  })

  it('never blocks a send when the host rendered no graph — stale data must not wedge the tool', () => {
    const root = makeAgentWorkspace()
    expect(runSh(root, ['handoff', 'anyone-at-all', '-m', 'hi'])).toContain('queued parcel')
  })

  it('is a POSIX sh script with strict mode and no bashisms or ${...} interpolation', () => {
    const sh = renderAgentScript()
    expect(sh.startsWith('#!/bin/sh\n')).toBe(true)
    expect(sh).toContain('set -eu')
    expect(sh).not.toContain('[[') // no bash [[ ]]
    expect(sh).not.toContain('${') // guards replace parameter defaults, so nothing interpolates
  })

  it('documents agent.sh as the canonical command surface', () => {
    const sh = renderAgentScript()
    expect(sh).toContain('agent.sh — your Quimby coordination tool')
    expect(sh).toContain('assignment set -m')
    expect(sh).toContain('status append -m')
    expect(sh).toContain('inbox [list]')
    expect(sh).not.toContain('run: quimby-agent.sh help')
  })

  it('emits the exact mailbox layout the host scans, and never crosses the boundary', () => {
    const sh = renderAgentScript()
    expect(sh).toContain('handoff/out/draft/$recipient')
    expect(sh).toContain('handoff/out/queued/$recipient')
    expect(sh).toContain('handoff/in/received')
    expect(sh).toContain('handoff/in/processed')
    // the publish step is an atomic same-fs rename of the whole draft dir
    expect(sh).toContain('mv "$draft" "$queued"')
  })

  it('renders the attest block and the attach frontmatter in the host-parseable shape', () => {
    const sh = renderAgentScript()
    expect(sh).toContain('```quimby-attest')
    expect(sh).toContain('attach: %s')
  })

  it('mkdirs through qa_mkdir, which names the stale-virtiofs-dentry cause on failure', () => {
    const sh = renderAgentScript()
    // The failing mkdir sites route through the helper, not a bare `mkdir -p`.
    expect(sh).toContain('qa_mkdir "$draft"')
    expect(sh).toContain('qa_mkdir "$ROOT/handoff/out/queued"')
    expect(sh).toContain('qa_mkdir "$ROOT/handoff/in/processed"')
    // …and the helper points at the guest-cache remedy rather than dying blind.
    expect(sh).toContain('stale virtiofs dentry')
    expect(sh).toContain('drop_caches')
  })

  const posix = process.platform !== 'win32'
  it.runIf(posix)('handoff produces a queued parcel the host attach-parser reads', () => {
    const root = makeAgentWorkspace()
    runSh(root, ['handoff', 'reviewer', '-m', 'please look', '--attach', 'builder'])
    const readme = readFileSync(
      join(root, 'handoff', 'out', 'queued', 'reviewer', 'README.md'),
      'utf-8',
    )
    const parsed = parseAttach(readme)
    expect(parsed.attach).toBe('builder')
    expect(parsed.note.trim()).toBe('please look')
    // authored in draft, then atomically published — draft is emptied
    expect(() =>
      readFileSync(join(root, 'handoff', 'out', 'draft', 'reviewer', 'README.md')),
    ).toThrow()
  })

  it.runIf(posix)('delegate marks an explicit user-delegated task for host promotion', () => {
    const root = makeAgentWorkspace()
    runSh(root, ['delegate', 'worker', '-m', 'review the new API'])
    const readme = readFileSync(
      join(root, 'handoff', 'out', 'queued', 'worker', 'README.md'),
      'utf-8',
    )
    expect(readme).toBe('---\ndelegated: true\n---\nreview the new API\n')
  })

  it.runIf(posix)('delegate requires a task message', () => {
    const root = makeAgentWorkspace()
    expect(() => runSh(root, ['delegate', 'worker'])).toThrow()
  })

  it.runIf(posix)('escalate/ask/reply write the host-parseable interrupt tags', () => {
    const root = makeAgentWorkspace()
    const read = (recipient: string): string =>
      readFileSync(join(root, 'handoff', 'out', 'queued', recipient, 'README.md'), 'utf-8')

    runSh(root, ['escalate', 'manager', '-m', 'blocked on X'])
    expect(read('manager')).toBe('---\nescalate: true\n---\nblocked on X\n')

    runSh(root, ['ask', 'builder', '-m', 'which auth did you use?'])
    expect(read('builder')).toBe('---\nexpects-reply: true\n---\nwhich auth did you use?\n')

    // a reply names a parcel actually received — the host honors the interrupt only then
    mkdirSync(join(root, 'handoff', 'in', 'received', 'manager-abc123'), { recursive: true })
    runSh(root, ['reply', 'manager', '--to', 'manager-abc123', '-m', 'used OAuth'])
    expect(read('manager')).toBe('---\nreply-to: manager-abc123\n---\nused OAuth\n')
  })

  it.runIf(posix)('reply requires --to <parcel>', () => {
    const root = makeAgentWorkspace()
    expect(() => runSh(root, ['reply', 'manager', '-m', 'answer'])).toThrow()
  })

  it.runIf(posix)('reply refuses a parcel this agent never received, listing what it has', () => {
    const root = makeAgentWorkspace()
    mkdirSync(join(root, 'handoff', 'in', 'received', 'review-real01'), { recursive: true })

    // Fails HERE rather than publishing a parcel the host would silently downgrade to advisory.
    expect(() => runSh(root, ['reply', 'review', '--to', 'review-typo99', '-m', 'answer'])).toThrow(
      /review-real01/,
    )
    expect(existsSync(join(root, 'handoff', 'out', 'queued', 'review'))).toBe(false)
  })

  it.runIf(posix)('reply accepts a parcel swept into the processed ledger by a sync', () => {
    const root = makeAgentWorkspace()
    // `quimby sync` removes in/processed/ but records the names — the reply window survives GC.
    writeFileSync(join(root, 'handoff', 'in', 'processed.ledger'), 'review-swept1\n')

    runSh(root, ['reply', 'review', '--to', 'review-swept1', '-m', 'answer'])
    expect(
      readFileSync(join(root, 'handoff', 'out', 'queued', 'review', 'README.md'), 'utf-8'),
    ).toContain('reply-to: review-swept1')
  })

  it.runIf(posix)('inbox show reads a delivered parcel', () => {
    const root = makeAgentWorkspace()
    mkdirSync(join(root, 'handoff', 'in', 'received', 'peer-xyz'), { recursive: true })
    writeFileSync(join(root, 'handoff', 'in', 'received', 'peer-xyz', 'README.md'), 'the note')
    expect(runSh(root, ['inbox', 'show', 'peer-xyz'])).toContain('the note')
  })

  it.runIf(posix)(
    'inbox show retries the mount-sync window, then reports a not-landed parcel',
    () => {
      const root = makeAgentWorkspace()
      // QA_INBOX_RETRIES=1 collapses the retry window so a genuinely-absent parcel fails fast; the
      // message draws the transient-vs-loss line ("announced but not landed") rather than a bare miss.
      expect(() =>
        runSh(root, ['inbox', 'show', 'ghost-abc'], root, { QA_INBOX_RETRIES: '1' }),
      ).toThrow(/not landed/)
    },
  )

  it.runIf(posix)('wake emits a name-independent orientation packet', () => {
    const root = makeAgentWorkspace()
    mkdirSync(join(root, 'handoff', 'in', 'received', 'peer-xyz'), { recursive: true })
    writeFileSync(
      join(root, 'handoff', 'in', 'received', 'peer-xyz', 'README.md'),
      'review my diff',
    )
    const out = runSh(root, ['wake'])
    expect(out).toContain('-- assignment --')
    expect(out).toContain('-- inbox (unprocessed) --')
    expect(out).toContain('-- peers --')
    // The parcel is surfaced although the courier never named it — the self-healing property.
    expect(out).toContain('peer-xyz')
  })

  it.runIf(posix)(
    'handoff works when invoked from inside repo/ (root is resolved by walking up)',
    () => {
      const root = makeAgentWorkspace()
      runSh(root, ['handoff', 'peer', '-m', 'hi'], join(root, 'repo'))
      expect(
        readFileSync(join(root, 'handoff', 'out', 'queued', 'peer', 'README.md'), 'utf-8'),
      ).toContain('hi')
    },
  )

  it.runIf(posix)('assignment show and set work from the repo directory', () => {
    const root = makeAgentWorkspace()
    runSh(root, ['assignment', 'set', '-m', 'build the thing'], join(root, 'repo'))
    expect(runSh(root, ['assignment'], join(root, 'repo'))).toContain('build the thing')
    expect(readFileSync(join(root, 'assignment.md'), 'utf-8')).toBe('build the thing\n')
  })

  it.runIf(posix)('status show, set, append, and done update the journal', () => {
    const root = makeAgentWorkspace()
    runSh(root, ['status', 'set', '-m', 'working'])
    runSh(root, ['status', 'append', '-m', 'blocked'])
    runSh(root, ['status', 'done', '-m', 'done: shipped'])
    const status = runSh(root, ['status'])
    expect(status).toContain('working')
    expect(status).toContain('blocked')
    expect(status).toContain('done: shipped')
  })

  it.runIf(posix)(
    'attest appends a block the host attestation-parser accepts, with atCommit from HEAD',
    () => {
      const root = makeAgentWorkspace()
      const head = execFileSync('git', ['-C', join(root, 'repo'), 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf-8',
      }).trim()
      runSh(root, [
        'attest',
        '--command',
        'npm run ci',
        '--result',
        'pass',
        '--summary',
        'all green',
      ])
      const att = parseAttestation(readFileSync(join(root, 'status.md'), 'utf-8'))
      expect(att).not.toBeNull()
      expect(att?.command).toBe('npm run ci')
      expect(att?.result).toBe('pass')
      expect(att?.atcommit).toBe(head)
    },
  )

  // The listing is a triage surface, not an index: it previews the note's first line AND tags the
  // interrupt class from host-stamped meta.yaml, so an inbox can be triaged without opening
  // anything. The tags deliberately come from metadata rather than note prose — a sender-typed
  // "TO:" prefix cannot be enforced and decays silently, since a reader cannot tell "not for me"
  // from "the sender forgot".
  // An advisory parcel deliberately does not wake its recipient, so without an ambient count the
  // only thing that can tell an agent it arrived is the host reminder sweep — which needs a running
  // server, is spaced by 10 minutes, and gives up after 3 tries. Until then the human relays "check
  // your inbox", which is the messenger problem quimby exists to remove.
  // A real incident: an agent gated on a prose "dispatch header", found a name that wasn't its own,
  // and refused host-stamped work delivered into its own inbox — twice. Note text is not addressing,
  // and an ABSENT addressee is not evidence either, so the host's routing has to be printed above
  // the prose where the question actually gets adjudicated.
  it.runIf(posix)(
    'prints the host routing above the note, so prose cannot masquerade as it',
    () => {
      const root = makeAgentWorkspace()
      const p = join(root, 'handoff', 'in', 'received', 'foreman-712c')
      mkdirSync(p, { recursive: true })
      writeFileSync(join(p, 'README.md'), 'TO: manager — decide the merge strategy\n\nbody\n')
      writeFileSync(join(p, 'meta.yaml'), 'from: foreman\nto: builder3\nuserDirected: true\n')

      const out = runSh(root, ['inbox', 'show', 'foreman-712c'])
      expect(out).toContain('delivered by quimby: from foreman → to builder3')
      // and it comes BEFORE the note, or it is not the thing being read first
      expect(out.indexOf('delivered by quimby')).toBeLessThan(out.indexOf('TO: manager'))
    },
  )

  it.runIf(posix)('degrades gracefully when meta.yaml carries no routing', () => {
    const root = makeAgentWorkspace()
    const p = join(root, 'handoff', 'in', 'received', 'peer-nometa')
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'README.md'), 'a note\n')
    // No meta.yaml at all — an older parcel. Must still print the note rather than error.
    expect(runSh(root, ['inbox', 'show', 'peer-nometa'])).toContain('a note')
  })

  // A mirror is a push cache that can silently never arrive — a sleeping server writes nothing,
  // ever. The distinction is already in the payload (a real snapshot has an `Updated:` line, the
  // placeholder deliberately does not), but `cat` discarded it, and three agents each invented a
  // different explanation for the same never-populated file.
  it.runIf(posix)('distinguishes a never-reported mirror from an old one', () => {
    const root = makeAgentWorkspace()
    writeFileSync(
      join(root, 'status', 'builder.md'),
      '# Status: builder\n\n_No status reported yet._\n',
    )
    writeFileSync(
      join(root, 'status', 'review.md'),
      '# Status: review\n\nUpdated: 2026-07-31T10:00:00Z\n\nworking\n',
    )
    const out = runSh(root, ['peers'])
    expect(out).toContain('builder')
    expect(out).toMatch(/builder.*never reported/)
    expect(out).toMatch(/review.*updated/)
  })

  it.runIf(posix)('leads a single peer read with its provenance, above the body', () => {
    const root = makeAgentWorkspace()
    writeFileSync(
      join(root, 'status', 'builder.md'),
      '# Status: builder\n\n_No status reported yet._\n',
    )
    const out = runSh(root, ['peers', 'builder'])
    expect(out).toContain('never reported')
    expect(out.indexOf('never reported')).toBeLessThan(out.indexOf('No status reported yet'))
  })

  // All placeholders means the HOST never fed them — a stopped server, not quiet peers. Deliberately
  // reported at `wake` rather than in the per-command footer: with the server down this holds
  // forever, and a line on every invocation would train the agent to skim the footer that also
  // carries the base and unread-parcel notices.
  it.runIf(posix)('says at wake when no peer has ever reported', () => {
    const root = makeAgentWorkspace()
    writeFileSync(join(root, 'status', 'a.md'), '# Status: a\n\n_No status reported yet._\n')
    expect(runSh(root, ['wake'])).toContain('no peer has EVER reported')
  })

  it.runIf(posix)('stays quiet at wake when at least one peer has reported', () => {
    const root = makeAgentWorkspace()
    writeFileSync(join(root, 'status', 'a.md'), '# Status: a\n\n_No status reported yet._\n')
    writeFileSync(join(root, 'status', 'b.md'), '# Status: b\n\nUpdated: 2026-08-01\n\nhi\n')
    expect(runSh(root, ['wake'])).not.toContain('no peer has EVER reported')
  })

  // `append` is easy and `set` is effortful, so the journal only grows — and its whole job is to be
  // the one thing a successor reads after a reset.
  it.runIf(posix)('warns when the status journal has grown past a readable size', () => {
    const root = makeAgentWorkspace()
    writeFileSync(join(root, 'status.md'), 'x'.repeat(17_000))
    const merged = execFileSync(
      'sh',
      ['-c', `sh ${join(root, 'agent.sh')} status append -m more 2>&1`],
      { cwd: root, encoding: 'utf-8' },
    )
    expect(merged).toContain('status set')
    // a warning, never a refusal — what belongs in the journal is judgment, not mechanics
    expect(readFileSync(join(root, 'status.md'), 'utf-8')).toContain('more')
  })

  it.runIf(posix)('says nothing about size for a short journal', () => {
    const root = makeAgentWorkspace()
    const merged = execFileSync(
      'sh',
      ['-c', `sh ${join(root, 'agent.sh')} status append -m short 2>&1`],
      { cwd: root, encoding: 'utf-8' },
    )
    expect(merged).not.toContain('status set')
  })

  it.runIf(posix)('reports unread parcels after an unrelated command', () => {
    const root = makeAgentWorkspace()
    const p = join(root, 'handoff', 'in', 'received', 'auditor-a1')
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'README.md'), 'independent review: three findings')
    writeFileSync(join(p, 'meta.yaml'), 'from: auditor\n')
    const merged = execFileSync('sh', ['-c', `sh ${join(root, 'agent.sh')} status 2>&1`], {
      cwd: root,
      encoding: 'utf-8',
    })
    expect(merged).toContain('1 unread parcel(s) in your inbox')
  })

  it.runIf(posix)('stays silent about the inbox when it is empty', () => {
    const root = makeAgentWorkspace()
    const merged = execFileSync('sh', ['-c', `sh ${join(root, 'agent.sh')} status 2>&1`], {
      cwd: root,
      encoding: 'utf-8',
    })
    expect(merged).not.toContain('unread parcel')
  })

  it.runIf(posix)('does not repeat the count at inbox itself, which already shows the tray', () => {
    const root = makeAgentWorkspace()
    const p = join(root, 'handoff', 'in', 'received', 'auditor-a1')
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'README.md'), 'independent review')
    const merged = execFileSync('sh', ['-c', `sh ${join(root, 'agent.sh')} inbox 2>&1`], {
      cwd: root,
      encoding: 'utf-8',
    })
    expect(merged).toContain('auditor-a1')
    expect(merged).not.toContain('unread parcel(s)')
  })

  it.runIf(posix)('tags each parcel with its interrupt class from meta.yaml', () => {
    const root = makeAgentWorkspace()
    const drop = (name: string, note: string, meta: string): void => {
      const p = join(root, 'handoff', 'in', 'received', name)
      mkdirSync(p, { recursive: true })
      writeFileSync(join(p, 'README.md'), note)
      writeFileSync(join(p, 'meta.yaml'), meta)
    }
    drop('builder-b1', 'blocked on the fixture path', 'from: builder\nescalation: true\n')
    drop('review-r1', 'which ref should I target?', 'from: review\nexpectsReply: true\n')
    drop('builder-b2', 'answer: origin/main', 'from: builder\nreplyTo: manager-9f2\n')
    drop('peer-p1', 'fyi, refactored the loader', 'from: peer\n')

    const out = runSh(root, ['inbox'])
    expect(out).toContain('builder-b1 [escalation] — blocked on the fixture path')
    expect(out).toContain('review-r1 [awaiting your reply] — which ref should I target?')
    expect(out).toContain('builder-b2 [reply] — answer: origin/main')
    // An ordinary advisory gets no tag — the classes have to mean something, so everything cannot
    // carry one.
    expect(out).toContain('peer-p1 — fyi, refactored the loader')
  })

  // The mechanism has to be stated where it is discoverable. Describing `inbox` only by its result
  // ("list delivered parcels") is how a tool gets used all session with its capability unseen.
  it('documents that the listing previews and that show prints in full', () => {
    const sh = renderAgentScript()
    expect(sh).toMatch(/inbox \[list\][^\n]*PREVIEWS/)
    expect(sh).toContain('[awaiting your reply]')
    expect(sh).toMatch(/inbox show[^\n]*IN FULL/)
  })

  it.runIf(posix)('inbox lists a delivered parcel and moves it to processed on done', () => {
    const root = makeAgentWorkspace()
    const parcel = join(root, 'handoff', 'in', 'received', 'builder-abc123')
    mkdirSync(parcel, { recursive: true })
    writeFileSync(join(parcel, 'README.md'), 'fix the null case')
    writeFileSync(join(parcel, 'meta.yaml'), 'userDirected: true\n')
    expect(runSh(root, ['inbox'])).toContain('builder-abc123 [user-directed]')
    expect(runSh(root, ['inbox', 'show', 'builder-abc123'])).toContain(
      'user-directed work (host-stamped)',
    )
    runSh(root, ['inbox', 'done', 'builder-abc123'])
    expect(() => readFileSync(join(parcel, 'README.md'))).toThrow()
    expect(
      readFileSync(
        join(root, 'handoff', 'in', 'processed', 'builder-abc123', 'README.md'),
        'utf-8',
      ),
    ).toContain('fix the null case')
  })

  it.runIf(posix)('refuses to run outside an agent workspace', () => {
    const root = makeAgentWorkspace()
    const elsewhere = mkdtempSync(join(tmpdir(), 'qa-out-'))
    dirs.push(elsewhere)
    expect(() => runSh(root, ['inbox'], elsewhere)).toThrow()
  })
})

describe('renderAgentScriptCmd', () => {
  it('is a batch script that mirrors the sh verbs and uses CRLF line endings', () => {
    const cmd = renderAgentScriptCmd()
    expect(cmd.startsWith('@echo off\r\n')).toBe(true)
    expect(cmd).toContain(':assignment')
    expect(cmd).toContain(':status')
    expect(cmd).toContain(':handoff')
    expect(cmd).toContain(':attest')
    expect(cmd).toContain(':inbox')
    expect(cmd).toContain(':peers')
    expect(cmd).toContain('"delegate"')
    expect(cmd).toContain('delegated: true')
    // Interrupt-channel verbs mirror the sh (§6b/§6c); best-effort on Windows, POSIX .sh canonical.
    expect(cmd).toContain('"escalate"')
    expect(cmd).toContain('escalate: true')
    expect(cmd).toContain('"ask"')
    expect(cmd).toContain('expects-reply: true')
    expect(cmd).toContain('"reply"')
    expect(cmd).toContain('reply-to: %REPLYTO%')
    expect(cmd).toContain('--file')
    expect(cmd).toContain('```quimby-attest')
  })
})
