import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentRepoDir } from '@quimbyhq/paths'
import type { SSHTransport } from '@quimbyhq/transport'
import { getSSHTransport } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { ensureWorkspace, loadState, saveState } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setAgentSyncRef } from './config'
import { addAgent } from './lifecycle'
import { getAgentPendingWork, getAgentSyncStatus, syncAgent } from './sync'

vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: vi.fn(),
}))

const mockedGetSSH = vi.mocked(getSSHTransport)

function fakeSSHTransport(logOut = ''): { transport: SSHTransport; calls: string[] } {
  const calls: string[] = []
  const transport = {
    syncProjectTo: vi.fn(async () => {}),
    exec: vi.fn(async (cmd: string) => {
      calls.push(cmd)
      if (cmd.includes('log quimby/seed..HEAD')) return logOut
      if (cmd.includes('status --porcelain')) return ''
      return ''
    }),
  } as unknown as SSHTransport
  return { transport, calls }
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

describe('syncAgent', () => {
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
})
