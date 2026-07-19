import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getAgentDir,
  getAgentHandoffInProcessedDir,
  getAgentHandoffOutSentDir,
  getAgentRepoDir,
} from '@quimbyhq/paths'
import type { SSHTransport } from '@quimbyhq/transport'
import { getSSHTransport } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace, loadState, saveState } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setAgentSyncRef } from './config'
import { addAgent } from './lifecycle'
import {
  getAgentPendingWork,
  getAgentSyncStatus,
  getAgentWorkSummary,
  pruneAgentMailboxCaches,
  syncAgent,
} from './sync'

vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: vi.fn(),
}))

const mockedGetSSH = vi.mocked(getSSHTransport)

function fakeSSHTransport(logOut = ''): {
  transport: SSHTransport
  calls: string[]
  files: Record<string, string>
} {
  const calls: string[] = []
  const files: Record<string, string> = {}
  const transport = {
    syncProjectTo: vi.fn(async () => {}),
    exec: vi.fn(async (cmd: string) => {
      calls.push(cmd)
      if (cmd.includes('log quimby/seed..HEAD')) return logOut
      if (cmd.includes('status --porcelain')) return ''
      return ''
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      files[path] = content
    }),
  } as unknown as SSHTransport
  return { transport, calls, files }
}

async function registerSSHAgent(name: string, id: string, seedCommit: string): Promise<void> {
  const state = await loadState(dir)
  state.agents[name] = {
    id,
    name,
    seedCommit,
    syncRef: state.sourceRef,
    createdAt: '2024-01-01T00:00:00.000Z',
    location: { type: 'ssh', host: 'user@box', base: '~' },
  } as AgentState
  await saveState(dir, state)
}

vi.mock('@quimbyhq/git', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    clone: vi.fn(async (_url: string, dest: string) => {
      await mkdir(dest, { recursive: true })
      await execa('git', ['init'], { cwd: dest })
      await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: dest })
      await execa('git', ['config', 'user.name', 'Test User'], { cwd: dest })
      await writeFile(join(dest, '.gitkeep'), '')
      await execa('git', ['add', '-A'], { cwd: dest })
      await execa('git', ['commit', '-m', 'initial'], { cwd: dest })
    }),
  }
})

let dir: string

async function setupGitRepo(repoDir: string) {
  await mkdir(repoDir, { recursive: true })
  await execa('git', ['init'], { cwd: repoDir })
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir })
  await writeFile(join(repoDir, 'README.md'), '# Test')
  await execa('git', ['add', '-A'], { cwd: repoDir })
  await execa('git', ['commit', '-m', 'initial'], { cwd: repoDir })
}

// A real local clone of the host repo (bypassing the mocked git.clone), tagged
// quimby/seed and registered in state — the setup syncAgent expects, so its adapter
// wiring (fetch/reset/rebase/tag over a real origin) is exercised end to end.
async function registerLocalAgentClone(name: string, id: string): Promise<void> {
  const agentRepoDir = getAgentRepoDir(dir, id)
  await execa('git', ['clone', dir, agentRepoDir])
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: agentRepoDir })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: agentRepoDir })
  await execa('git', ['tag', 'quimby/seed'], { cwd: agentRepoDir })
  const seed = (await execa('git', ['rev-parse', 'HEAD'], { cwd: agentRepoDir })).stdout.trim()
  const state = await loadState(dir)
  state.agents[name] = {
    id,
    name,
    seedCommit: seed,
    syncRef: state.sourceRef,
    createdAt: '2024-01-01T00:00:00.000Z',
    location: { type: 'local' },
  } as AgentState
  await saveState(dir, state)
}

async function advanceHost(label: string): Promise<string> {
  await writeFile(join(dir, `${label}.txt`), `${label}\n`)
  await execa('git', ['add', '-A'], { cwd: dir })
  await execa('git', ['commit', '-m', label], { cwd: dir })
  return (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
}

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-sync-${crypto.randomUUID()}`)
  await setupGitRepo(dir)
  await ensureWorkspace(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('getAgentPendingWork', () => {
  it('reports commits ahead and dirtiness for a local agent', async () => {
    await registerLocalAgentClone('carol', 'carol-id')
    const state = await loadState(dir)
    const agent = state.agents.carol

    expect(await getAgentPendingWork(dir, state.id, agent)).toEqual({ commits: 0, dirty: false })

    const repoDir = getAgentRepoDir(dir, 'carol-id')
    await writeFile(join(repoDir, 'work.txt'), 'work\n')
    await execa('git', ['add', '-A'], { cwd: repoDir })
    await execa('git', ['commit', '-m', 'agent work'], { cwd: repoDir })
    await writeFile(join(repoDir, 'scratch.txt'), 'uncommitted\n')

    expect(await getAgentPendingWork(dir, state.id, agent)).toEqual({ commits: 1, dirty: true })
  })

  it('returns null when the agent repo is unreadable', async () => {
    const agent = { id: 'missing-id', name: 'ghost', location: { type: 'local' } } as AgentState
    expect(await getAgentPendingWork(dir, 'proj', agent)).toBeNull()
  })
})

describe('getAgentSyncStatus', () => {
  function agentAt(seedCommit: string, syncRef: string): AgentState {
    return {
      id: 'agent-uuid',
      name: 'alice',
      seedCommit,
      syncRef,
      createdAt: '2024-01-01T00:00:00.000Z',
    } as AgentState
  }

  it('reports 0 behind when the agent seed is the syncRef tip', async () => {
    const state = await loadState(dir)
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
    const { behind } = await getAgentSyncStatus(
      dir,
      agentAt(head, state.sourceRef),
      state.sourceRef,
    )
    expect(behind).toBe(0)
  })

  it('reports the commit count when the host has advanced past the agent seed', async () => {
    const state = await loadState(dir)
    const seed = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
    await writeFile(join(dir, 'next.txt'), 'next\n')
    await execa('git', ['add', '-A'], { cwd: dir })
    await execa('git', ['commit', '-m', 'advance host'], { cwd: dir })
    const { behind } = await getAgentSyncStatus(
      dir,
      agentAt(seed, state.sourceRef),
      state.sourceRef,
    )
    expect(behind).toBe(1)
  })

  it('uses the fallback ref when agent has no syncRef', async () => {
    const state = await loadState(dir)
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
    const agent = { ...agentAt(head, state.sourceRef), syncRef: undefined } as unknown as AgentState
    const { syncRef } = await getAgentSyncStatus(dir, agent, state.sourceRef)
    expect(syncRef).toBe(state.sourceRef)
  })
})

describe('getAgentWorkSummary', () => {
  it('summarizes committed + uncommitted work against the seed for a local agent', async () => {
    await registerLocalAgentClone('alice', 'a1')
    const repoDir = getAgentRepoDir(dir, 'a1')
    // One commit on top of seed, plus an uncommitted edit to a tracked file.
    await writeFile(join(repoDir, 'feature.txt'), 'x\ny\n')
    await execa('git', ['add', '-A'], { cwd: repoDir })
    await execa('git', ['commit', '-m', 'feat'], { cwd: repoDir })
    await writeFile(join(repoDir, 'README.md'), '# Test\nmore\n')

    const state = await loadState(dir)
    const summary = await getAgentWorkSummary(dir, state.id, state.agents.alice)
    expect(summary).not.toBeNull()
    expect(summary!.commits).toBe(1)
    expect(summary!.files).toBe(2) // feature.txt + README.md
    expect(summary!.insertions).toBeGreaterThanOrEqual(3)
  })

  it('reports zero work for a freshly cloned local agent at its seed', async () => {
    await registerLocalAgentClone('bob', 'b1')
    const state = await loadState(dir)
    expect(await getAgentWorkSummary(dir, state.id, state.agents.bob)).toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
      commits: 0,
    })
  })

  it('sums remote tracked + untracked work for an SSH agent', async () => {
    const transport = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('diff --numstat')) return '2\t1\tfile.ts\n-\t-\timg.png\n'
        if (cmd.includes('ls-files --others')) return 'new1.txt\nnew2.txt\n'
        if (cmd.includes('rev-list --count')) return '3\n'
        return ''
      }),
    } as unknown as SSHTransport
    mockedGetSSH.mockReturnValue(transport)
    await registerSSHAgent('remote', 'r1', 'seedsha')

    const state = await loadState(dir)
    const summary = await getAgentWorkSummary(dir, state.id, state.agents.remote)
    // 2 tracked (file.ts + binary img.png) + 2 untracked = 4 files; binary adds no line deltas.
    expect(summary).toEqual({ files: 4, insertions: 2, deletions: 1, commits: 3 })
  })

  it('returns null when the agent repo cannot be read', async () => {
    const state = await loadState(dir)
    const ghost = {
      id: 'no-such-id',
      name: 'ghost',
      seedCommit: 'x',
      syncRef: state.sourceRef,
      createdAt: '2024-01-01T00:00:00.000Z',
      location: { type: 'local' },
    } as AgentState
    expect(await getAgentWorkSummary(dir, state.id, ghost)).toBeNull()
  })
})

describe('pruneAgentMailboxCaches', () => {
  it('sweeps out/sent and in/processed but leaves active parcels, assignment, and status', async () => {
    await registerLocalAgentClone('carol', 'carol-id')
    const agentDir = getAgentDir(dir, 'carol-id')
    // Archives to sweep:
    await mkdir(join(getAgentHandoffOutSentDir(dir, 'carol-id'), 'reviewer'), { recursive: true })
    await mkdir(join(getAgentHandoffInProcessedDir(dir, 'carol-id'), 'builder-abc'), {
      recursive: true,
    })
    // Active mailbox that must survive:
    await mkdir(join(agentDir, 'handoff', 'out', 'queued', 'reviewer'), { recursive: true })
    await mkdir(join(agentDir, 'handoff', 'in', 'received', 'builder-xyz'), { recursive: true })
    await writeFile(join(agentDir, 'assignment.md'), 'do the thing')

    const agent = (await loadState(dir)).agents.carol
    await pruneAgentMailboxCaches(dir, agent, 'proj-id')

    expect(await exists(getAgentHandoffOutSentDir(dir, 'carol-id'))).toBe(false)
    expect(await exists(getAgentHandoffInProcessedDir(dir, 'carol-id'))).toBe(false)
    expect(await exists(join(agentDir, 'handoff', 'out', 'queued', 'reviewer'))).toBe(true)
    expect(await exists(join(agentDir, 'handoff', 'in', 'received', 'builder-xyz'))).toBe(true)
    expect(await exists(join(agentDir, 'assignment.md'))).toBe(true)
  })

  it('rm -rf the remote out/sent and in/processed over transport for an SSH agent', async () => {
    const { transport, calls } = fakeSSHTransport('')
    mockedGetSSH.mockReturnValue(transport)
    await registerSSHAgent('remo', 'remo-id', 'seed-sha')
    const agent = (await loadState(dir)).agents.remo

    await pruneAgentMailboxCaches(dir, agent, 'proj-id')

    expect(calls.some((c) => c.includes('rm -rf') && c.includes('/handoff/out/sent'))).toBe(true)
    expect(calls.some((c) => c.includes('/handoff/in/processed'))).toBe(true)
  })
})

describe('syncAgent', () => {
  it('prunes the out/sent and in/processed caches after a successful sync', async () => {
    await registerLocalAgentClone('gc', 'gc-id')
    await mkdir(join(getAgentHandoffOutSentDir(dir, 'gc-id'), 'reviewer'), { recursive: true })
    await mkdir(join(getAgentHandoffInProcessedDir(dir, 'gc-id'), 'builder-abc'), {
      recursive: true,
    })
    await advanceHost('feature')

    await syncAgent(dir, 'gc')

    expect(await exists(getAgentHandoffOutSentDir(dir, 'gc-id'))).toBe(false)
    expect(await exists(getAgentHandoffInProcessedDir(dir, 'gc-id'))).toBe(false)
  })

  it('throws a clear error when the sync ref does not resolve', async () => {
    await addAgent(dir, 'alice')
    await setAgentSyncRef(dir, 'alice', 'no-such-branch')
    await expect(syncAgent(dir, 'alice')).rejects.toThrow(/doesn't resolve/)
  })

  it('fast-forwards a local agent onto the advanced host and persists the seed', async () => {
    await registerLocalAgentClone('alice', 'alice-id')
    const head = await advanceHost('feature')

    const result = await syncAgent(dir, 'alice')

    expect(result).toEqual({ newSeed: head, rebased: false, commitsReplayed: 0 })
    // the seed is persisted and the tag moved in the agent's clone
    expect((await loadState(dir)).agents.alice.seedCommit).toBe(head)
    const repoDir = getAgentRepoDir(dir, 'alice-id')
    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim()).toBe(head)
    expect((await execa('git', ['rev-parse', 'quimby/seed'], { cwd: repoDir })).stdout.trim()).toBe(
      head,
    )
  })

  it('is a no-op when the agent is already at the host tip', async () => {
    await registerLocalAgentClone('bob', 'bob-id')
    const seed = (await loadState(dir)).agents.bob.seedCommit

    const result = await syncAgent(dir, 'bob')

    expect(result).toEqual({ newSeed: seed, rebased: false, commitsReplayed: 0 })
  })

  it('drives the remote git commands over transport for an SSH agent (no local commits)', async () => {
    const { transport, calls } = fakeSSHTransport('') // no commits past seed
    mockedGetSSH.mockReturnValue(transport)
    await registerSSHAgent('remote', 'remote-id', 'oldseed0000')
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()

    const result = await syncAgent(dir, 'remote')

    expect(result).toEqual({ newSeed: head, rebased: false, commitsReplayed: 0 })
    expect(transport.syncProjectTo).toHaveBeenCalled()
    // exact remote command strings the algorithm's remote adapter must issue
    expect(calls).toContain('git fetch origin')
    expect(calls).toContain('git log quimby/seed..HEAD --format=%H')
    expect(calls).toContain('git status --porcelain')
    expect(calls).toContain(`git reset --hard ${head}`)
    expect(calls).toContain(`git tag -f quimby/seed ${head}`)
    // no local commits → fast-forward, never a rebase
    expect(calls.some((c) => c.startsWith('git rebase'))).toBe(false)
  })

  it('stashes, rebases, and pops for an SSH agent with dirty local commits', async () => {
    const { transport, calls } = fakeSSHTransport('h1\nh2') // two commits past seed
    // report a dirty tree so the stash/pop path runs
    ;(transport.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      calls.push(cmd)
      if (cmd.includes('log quimby/seed..HEAD')) return 'h1\nh2'
      if (cmd.includes('status --porcelain')) return ' M file.ts'
      return ''
    })
    mockedGetSSH.mockReturnValue(transport)
    await registerSSHAgent('remote', 'remote-id', 'oldseed0000')
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()

    const result = await syncAgent(dir, 'remote')

    expect(result).toEqual({ newSeed: head, rebased: true, commitsReplayed: 2 })
    expect(calls).toContain('git stash push --include-untracked -m quimby-sync')
    expect(calls).toContain(`git rebase ${head}`)
    expect(calls).toContain('git stash pop')
  })

  it('refreshes the Quimby-tier scaffold onto the agent dir without clobbering assignment/status', async () => {
    await registerLocalAgentClone('scaf', 'scaf-id')
    const agentDir = getAgentDir(dir, 'scaf-id')
    // pre-existing task/status the refresh must leave untouched
    await writeFile(join(agentDir, 'assignment.md'), 'MY TASK')
    await writeFile(join(agentDir, 'status.md'), 'working')
    await advanceHost('feature')

    await syncAgent(dir, 'scaf')

    // generated instruction + tool files land (or are refreshed) on disk
    expect(await exists(join(agentDir, 'CLAUDE.md'))).toBe(true)
    expect(await exists(join(agentDir, 'AGENTS.md'))).toBe(true)
    expect(await exists(join(agentDir, 'agent.sh'))).toBe(true)
    // …but the refresh writes only generated files — the agent's task and status survive
    expect(await readFile(join(agentDir, 'assignment.md'), 'utf8')).toBe('MY TASK')
    expect(await readFile(join(agentDir, 'status.md'), 'utf8')).toBe('working')
  })

  it('writes the refreshed scaffold over transport for an SSH agent', async () => {
    const { transport, files } = fakeSSHTransport('') // no commits past seed
    mockedGetSSH.mockReturnValue(transport)
    await registerSSHAgent('remote', 'remote-id', 'oldseed0000')

    await syncAgent(dir, 'remote')

    const written = Object.keys(files)
    expect(written.some((p) => p.endsWith('/CLAUDE.md'))).toBe(true)
    expect(written.some((p) => p.endsWith('/AGENTS.md'))).toBe(true)
    expect(written.some((p) => p.endsWith('/agent.sh'))).toBe(true)
  })
})
