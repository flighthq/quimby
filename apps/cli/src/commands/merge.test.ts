import { mkdir, rm, writeFile } from 'node:fs/promises'
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
