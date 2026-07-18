import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAgent } from '@quimbyhq/agent'
import { getAgentDir, getAgentRepoDir } from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { loadState, resolveWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => {
    throw new Error('No quimby workspace found')
  }),
}))

const tmpDirs: string[] = []

afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true })
  tmpDirs.length = 0
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa('git', args, { cwd })).stdout.trim()
}

// A host repo with a committed .gitignore (so the tree is clean for the merge precondition)
// and one local agent carrying a single committed change since its seed.
async function setupHostAndAgent(): Promise<{ host: string; agentId: string }> {
  const host = join(tmpdir(), `quimby-merge-${crypto.randomUUID()}`)
  tmpDirs.push(host)
  await mkdir(host, { recursive: true })
  await execa('git', ['init', '-b', 'main'], { cwd: host })
  await git(host, 'config', 'user.email', 't@t')
  await git(host, 'config', 'user.name', 't')
  await writeFile(join(host, 'base.txt'), 'base\n')
  await git(host, 'add', '-A')
  await git(host, 'commit', '-m', 'initial')

  const agent = await addAgent(host, 'alice')
  await git(host, 'add', '.gitignore')
  await git(host, 'commit', '-m', 'ignore quimby')

  const agentRepo = getAgentRepoDir(host, agent.id)
  await writeFile(join(agentRepo, 'feature.txt'), 'work\n')
  await git(agentRepo, 'add', '-A')
  await git(agentRepo, 'commit', '-m', 'add feature')
  return { host, agentId: agent.id }
}

function mergeArgs(overrides: Record<string, unknown>) {
  return {
    args: {
      agent: 'alice',
      commits: false,
      patch: false,
      '3way': false,
      rebase: false,
      // `sync` omitted (undefined) means advance-on by default, mirroring citty with no --sync flag.
      ...overrides,
    },
  } as never
}

describe('editCommitMessage', () => {
  it('edits the commit message through a COMMIT_EDITMSG path for gitcommit syntax', async () => {
    const repo = join(tmpdir(), `quimby-merge-editor-${crypto.randomUUID()}`)
    tmpDirs.push(repo)
    await mkdir(repo, { recursive: true })
    await execa('git', ['init', '-b', 'main'], { cwd: repo })

    const editor = join(repo, 'editor.sh')
    const seen = join(repo, 'seen.txt')
    await writeFile(
      editor,
      [
        '#!/bin/sh',
        'echo "$(basename "$2")" > "$1"',
        'echo "$(dirname "$2")" >> "$1"',
        'printf "Edited subject\\n\\n# ignored\\n" > "$2"',
        '',
      ].join('\n'),
    )
    await chmod(editor, 0o755)
    await git(repo, 'config', 'core.editor', `${editor} ${seen}`)

    const { editCommitMessage } = await import('./merge')
    // git's editor precedence puts $GIT_EDITOR/$VISUAL/$EDITOR above core.editor, so an
    // ambient editor env var (the sandbox exports GIT_EDITOR=true to keep git from opening an
    // interactive editor) would outrank the core.editor this test configures. Neutralize them
    // so the resolved editor is this test's script, then restore.
    const savedEditorEnv = {
      GIT_EDITOR: process.env.GIT_EDITOR,
      VISUAL: process.env.VISUAL,
      EDITOR: process.env.EDITOR,
    }
    delete process.env.GIT_EDITOR
    delete process.env.VISUAL
    delete process.env.EDITOR
    try {
      await expect(editCommitMessage(repo, 'Original subject')).resolves.toBe('Edited subject')

      const [basename, tempDir] = (await readFile(seen, 'utf8')).trim().split('\n')
      expect(basename).toBe('COMMIT_EDITMSG')
      expect(await exists(tempDir!)).toBe(false)
    } finally {
      for (const [key, value] of Object.entries(savedEditorEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe('runMergeCommand', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./merge')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when workspace is missing', async () => {
    const { default: cmd } = await import('./merge')
    await expect(
      cmd.run!({ args: { agent: 'alice', commits: false, patch: false } } as never),
    ).rejects.toThrow()
  })

  it('advances the seed when merging via a subdirectory of the same repo', async () => {
    const { host } = await setupHostAndAgent()
    const before = (await loadState(host)).agents.alice.seedCommit
    // Targeting a subdir of the workspace is the same scenario as running `merge` from a
    // subdir: targetRepoPath is the subdir, but repoRoot is the git toplevel. The seed
    // advance must still fire (it wrongly skipped when the guard compared raw paths).
    const subdir = join(host, 'sub', 'nested')
    await mkdir(subdir, { recursive: true })

    vi.mocked(resolveWorkspace).mockResolvedValueOnce({
      state: await loadState(host),
      repoRoot: host,
    })
    const { default: cmd } = await import('./merge')
    await cmd.run!(mergeArgs({ message: 'land it', target: subdir }))

    const hostHead = await git(host, 'rev-parse', 'HEAD')
    const after = (await loadState(host)).agents.alice.seedCommit
    expect(after).toBe(hostHead)
    expect(after).not.toBe(before)
    // The agent's work actually landed (git apply/add run from the repo toplevel, not the
    // subdir — a subdir-relative apply would silently drop the change).
    expect(await exists(join(host, 'feature.txt'))).toBe(true)
    // Workspace state is never committed into the merge, even though the agent's seed
    // predates the .gitignore commit.
    const tracked = await git(host, 'ls-files')
    expect(tracked).not.toContain('.quimby')
  })

  it('proceeds with a failing attestation — informational, never a gate', async () => {
    const { host, agentId } = await setupHostAndAgent()
    await writeFile(
      join(getAgentDir(host, agentId), 'status.md'),
      '```quimby-attest\ncommand: npm run ci\nresult: fail\n```',
    )
    vi.mocked(resolveWorkspace).mockResolvedValueOnce({
      state: await loadState(host),
      repoRoot: host,
    })
    const { default: cmd } = await import('./merge')
    await cmd.run!(mergeArgs({ message: 'land it', target: host }))
    // The merge still landed despite `result: fail` — the attestation only informs.
    expect(await exists(join(host, 'feature.txt'))).toBe(true)
  })

  it('leaves the seed alone with --no-sync', async () => {
    const { host } = await setupHostAndAgent()
    const before = (await loadState(host)).agents.alice.seedCommit
    vi.mocked(resolveWorkspace).mockResolvedValueOnce({
      state: await loadState(host),
      repoRoot: host,
    })
    const { default: cmd } = await import('./merge')
    // citty yields `false` for --no-sync.
    await cmd.run!(mergeArgs({ message: 'land it', target: host, sync: false }))
    expect((await loadState(host)).agents.alice.seedCommit).toBe(before)
  })

  it('does not replay commits again when retrying with --no-sync (alreadyApplied path)', async () => {
    const { host } = await setupHostAndAgent()
    const before = (await loadState(host)).agents.alice.seedCommit
    const { default: cmd } = await import('./merge')

    vi.mocked(resolveWorkspace).mockResolvedValueOnce({
      state: await loadState(host),
      repoRoot: host,
    })
    await cmd.run!(mergeArgs({ commits: true, target: host, sync: false }))
    const headAfterFirst = await git(host, 'rev-parse', 'HEAD')
    expect((await loadState(host)).agents.alice.seedCommit).toBe(before)

    vi.mocked(resolveWorkspace).mockResolvedValueOnce({
      state: await loadState(host),
      repoRoot: host,
    })
    // --no-sync skips the pre-sync, so the agent still carries its commit and the
    // already-applied detection in applyHandoff is what prevents a double replay.
    await cmd.run!(mergeArgs({ commits: true, target: host, sync: false }))

    expect(await git(host, 'rev-parse', 'HEAD')).toBe(headAfterFirst)
    expect((await loadState(host)).agents.alice.seedCommit).toBe(before)
    const subjects = (await git(host, 'log', '--format=%s')).split('\n')
    expect(subjects.filter((subject) => subject === 'add feature')).toHaveLength(1)
  })

  it('pre-syncs by default: a re-merge of already-landed work finds nothing and advances the seed', async () => {
    const { host } = await setupHostAndAgent()
    const { default: cmd } = await import('./merge')

    // Land once with --no-sync so the agent keeps its commit and its seed doesn't advance.
    vi.mocked(resolveWorkspace).mockResolvedValueOnce({
      state: await loadState(host),
      repoRoot: host,
    })
    await cmd.run!(mergeArgs({ commits: true, target: host, sync: false }))
    const headAfterFirst = await git(host, 'rev-parse', 'HEAD')

    // Re-merge with the default (pre-sync on): the pre-sync rebases the agent onto the branch,
    // dropping the now-duplicate commit and advancing its seed, so nothing is left to carry —
    // reported cleanly rather than as a "nothing to hand off" error.
    vi.mocked(resolveWorkspace).mockResolvedValueOnce({
      state: await loadState(host),
      repoRoot: host,
    })
    await cmd.run!(mergeArgs({ commits: true, target: host }))

    expect(await git(host, 'rev-parse', 'HEAD')).toBe(headAfterFirst)
    expect((await loadState(host)).agents.alice.seedCommit).toBe(headAfterFirst)
    const subjects = (await git(host, 'log', '--format=%s')).split('\n')
    expect(subjects.filter((subject) => subject === 'add feature')).toHaveLength(1)
  })

  it('by default pre-syncs and aborts on a rebase conflict without crossing the boundary', async () => {
    const { host, agentId } = await setupHostAndAgent()
    const agentRepo = getAgentRepoDir(host, agentId)
    // The agent edits base.txt on its side...
    await writeFile(join(agentRepo, 'base.txt'), 'agent-change\n')
    await git(agentRepo, 'commit', '-am', 'agent edits base')
    // ...and the tracked branch edits the same line differently, so rebasing onto it conflicts.
    await writeFile(join(host, 'base.txt'), 'host-change\n')
    await git(host, 'commit', '-am', 'host edits base')

    vi.mocked(resolveWorkspace).mockResolvedValueOnce({
      state: await loadState(host),
      repoRoot: host,
    })
    const { default: cmd } = await import('./merge')
    await expect(cmd.run!(mergeArgs({ message: 'land it', target: host }))).rejects.toThrow(
      /rebase conflict|Resolve/i,
    )
    // The boundary was never crossed: the agent's feature work did not land, and no git merge
    // was left in progress in the host repo — the conflict stayed on the agent's side.
    expect(await exists(join(host, 'feature.txt'))).toBe(false)
    expect(await exists(join(host, '.git', 'MERGE_HEAD'))).toBe(false)
  })

  it('retargets the agent sync ref with --sync <ref> while advancing', async () => {
    const { host } = await setupHostAndAgent()
    await git(host, 'branch', 'release') // a ref to retarget onto (must resolve)
    expect((await loadState(host)).agents.alice.syncRef).toBe('main')
    vi.mocked(resolveWorkspace).mockResolvedValueOnce({
      state: await loadState(host),
      repoRoot: host,
    })
    const { default: cmd } = await import('./merge')
    await cmd.run!(mergeArgs({ message: 'land it', target: host, sync: 'release' }))
    expect((await loadState(host)).agents.alice.syncRef).toBe('release')
  })

  it('leaves the seed alone when landing on a fresh branch (-b)', async () => {
    const { host } = await setupHostAndAgent()
    const before = (await loadState(host)).agents.alice.seedCommit

    vi.mocked(resolveWorkspace).mockResolvedValueOnce({
      state: await loadState(host),
      repoRoot: host,
    })
    const { default: cmd } = await import('./merge')
    await cmd.run!(mergeArgs({ message: 'land it', target: host, branch: 'feature/x' }))

    const after = (await loadState(host)).agents.alice.seedCommit
    expect(after).toBe(before)
  })
})
