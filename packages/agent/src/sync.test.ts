import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentState } from '@quimbyhq/types'
import { ensureWorkspace, loadState } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setAgentSyncRef } from './config'
import { addAgent } from './lifecycle'
import { getAgentSyncStatus, syncAgent } from './sync'

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

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-sync-${crypto.randomUUID()}`)
  await setupGitRepo(dir)
  await ensureWorkspace(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
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
})
