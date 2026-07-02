import { describe, expect, it } from 'vitest'

import type { RepoSyncOps } from './syncAlgorithm'
import { runSyncAlgorithm } from './syncAlgorithm'

interface FakeConfig {
  commits?: number
  dirty?: boolean
  rebaseThrows?: boolean
  stashPopThrows?: boolean
}

function fakeOps(cfg: FakeConfig = {}): { ops: RepoSyncOps; calls: string[] } {
  const calls: string[] = []
  const ops: RepoSyncOps = {
    fetch: async () => {
      calls.push('fetch')
    },
    countCommitsSinceSeed: async () => cfg.commits ?? 0,
    isDirty: async () => cfg.dirty ?? false,
    stash: async () => {
      calls.push('stash')
    },
    resetHardTo: async (c) => {
      calls.push(`reset:${c}`)
    },
    rebaseOnto: async (c) => {
      calls.push(`rebase:${c}`)
      if (cfg.rebaseThrows) throw new Error('rebase conflict')
    },
    rebaseAbort: async () => {
      calls.push('rebaseAbort')
    },
    tagSeed: async (c) => {
      calls.push(`tag:${c}`)
    },
    stashPop: async () => {
      calls.push('stashPop')
      if (cfg.stashPopThrows) throw new Error('pop conflict')
    },
  }
  return { ops, calls }
}

describe('runSyncAlgorithm', () => {
  it('always fetches before touching the working tree', async () => {
    const { ops, calls } = fakeOps()
    await runSyncAlgorithm(ops, { hostHead: 'h', seedCommit: 'seed', name: 'a' })
    expect(calls[0]).toBe('fetch')
  })

  it('force hard-resets and retags without rebasing', async () => {
    const { ops, calls } = fakeOps({ commits: 3, dirty: true })
    const result = await runSyncAlgorithm(ops, {
      hostHead: 'H',
      seedCommit: 'seed',
      force: true,
      name: 'a',
    })
    expect(result).toEqual({ newSeed: 'H', rebased: false, commitsReplayed: 0 })
    expect(calls).toEqual(['fetch', 'reset:H', 'tag:H'])
  })

  it('is a no-op when the agent is already at hostHead', async () => {
    const { ops, calls } = fakeOps({ commits: 5 })
    const result = await runSyncAlgorithm(ops, { hostHead: 'same', seedCommit: 'same', name: 'a' })
    expect(result).toEqual({ newSeed: 'same', rebased: false, commitsReplayed: 0 })
    expect(calls).toEqual(['fetch'])
  })

  it('fast-forwards (reset) when the agent has no commits of its own', async () => {
    const { ops, calls } = fakeOps({ commits: 0 })
    const result = await runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a' })
    expect(result).toEqual({ newSeed: 'H', rebased: false, commitsReplayed: 0 })
    expect(calls).toEqual(['fetch', 'reset:H', 'tag:H'])
  })

  it('rebases the agent commits when it has some (clean tree)', async () => {
    const { ops, calls } = fakeOps({ commits: 2, dirty: false })
    const result = await runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a' })
    expect(result).toEqual({ newSeed: 'H', rebased: true, commitsReplayed: 2 })
    expect(calls).toEqual(['fetch', 'rebase:H', 'tag:H'])
  })

  it('auto-stashes a dirty tree and pops it after a successful rebase', async () => {
    const { ops, calls } = fakeOps({ commits: 1, dirty: true })
    await runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a' })
    expect(calls).toEqual(['fetch', 'stash', 'rebase:H', 'tag:H', 'stashPop'])
  })

  it('aborts and restores the stash on a rebase conflict, leaving work intact', async () => {
    const { ops, calls } = fakeOps({ commits: 1, dirty: true, rebaseThrows: true })
    await expect(
      runSyncAlgorithm(ops, { hostHead: 'abcdef12', seedCommit: 'old', name: 'alice' }),
    ).rejects.toThrow(/rebase conflicts onto abcdef12 — aborted, work intact/)
    expect(calls).toEqual(['fetch', 'stash', 'rebase:abcdef12', 'rebaseAbort', 'stashPop'])
    // never retagged the seed on the conflict path
    expect(calls).not.toContain('tag:abcdef12')
  })

  it('swallows a stash-pop failure during abort and still reports the rebase conflict', async () => {
    const { ops } = fakeOps({ commits: 1, dirty: true, rebaseThrows: true, stashPopThrows: true })
    await expect(
      runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a' }),
    ).rejects.toThrow(/rebase conflicts/)
  })

  it('reports a stash-pop conflict that occurs after a successful rebase', async () => {
    const { ops, calls } = fakeOps({ commits: 1, dirty: true, stashPopThrows: true })
    await expect(
      runSyncAlgorithm(ops, { hostHead: 'abcdef12', seedCommit: 'old', name: 'alice' }),
    ).rejects.toThrow(/synced onto abcdef12, but restoring its uncommitted work hit conflicts/)
    expect(calls).toContain('tag:abcdef12')
  })

  it('does not stash a clean tree', async () => {
    const { ops, calls } = fakeOps({ commits: 1, dirty: false })
    await runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a' })
    expect(calls).not.toContain('stash')
    expect(calls).not.toContain('stashPop')
  })
})
