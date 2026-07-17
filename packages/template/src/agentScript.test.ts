import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

function makeAgentWorkspace(): string {
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
  writeFileSync(shPath, renderAgentScript(), { mode: 0o755 })
  return root
}

function runSh(root: string, args: string[], cwd = root): string {
  return execFileSync('sh', [join(root, 'agent.sh'), ...args], { cwd, encoding: 'utf-8' })
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

describe('renderAgentScript', () => {
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

  it.runIf(posix)('inbox lists a delivered parcel and moves it to processed on done', () => {
    const root = makeAgentWorkspace()
    const parcel = join(root, 'handoff', 'in', 'received', 'builder-abc123')
    mkdirSync(parcel, { recursive: true })
    writeFileSync(join(parcel, 'README.md'), 'fix the null case')
    expect(runSh(root, ['inbox'])).toContain('builder-abc123')
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
    expect(cmd).toContain('--file')
    expect(cmd).toContain('```quimby-attest')
  })
})
