import { SyncConflictError } from '@quimbyhq/errors'
import { describe, expect, it } from 'vitest'

import type { RepoSyncOps, SyncConflictState } from './syncAlgorithm'
import { runSyncAlgorithm } from './syncAlgorithm'

// The `agentClean` flag a failed sync throws with — true only when the repo is left safe to
// capture from (a rolled-back rebase); `merge`'s fallback keys on it.
async function syncErr(ops: RepoSyncOps): Promise<SyncConflictError> {
  try {
    await runSyncAlgorithm(ops, {
      hostHead: 'abcdef12',
      seedCommit: 'old',
      name: 'alice',
      apply: true,
    })
  } catch (err) {
    return err as SyncConflictError
  }
  throw new Error('expected a SyncConflictError')
}

interface FakeConfig {
  commits?: number
  dirty?: boolean
  rebaseThrows?: boolean
  stashPopThrows?: boolean
  /** A pre-existing conflicted state blocking the safe sync's auto-stash. */
  conflict?: SyncConflictState
  /** Simulate a rebase abort that fails to clear the mid-rebase state. */
  abortFails?: boolean
}

function fakeOps(cfg: FakeConfig = {}): { ops: RepoSyncOps; calls: string[] } {
  const calls: string[] = []
  const ops: RepoSyncOps = {
    fetch: async () => {
      calls.push('fetch')
    },
    countCommitsSinceSeed: async () => cfg.commits ?? 0,
    pendingConflictState: async () => cfg.conflict ?? null,
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
      return !cfg.abortFails
    },
    tagSeed: async (c) => {
      calls.push(`tag:${c}`)
    },
    tagBase: async (c) => {
      calls.push(`tagBase:${c}`)
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
    await runSyncAlgorithm(ops, { hostHead: 'h', seedCommit: 'seed', name: 'a', apply: true })
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
    expect(result).toEqual({
      newSeed: 'H',
      rebased: false,
      commitsReplayed: 0,
      baseCommit: 'H',
      applied: true,
    })
    expect(calls).toEqual(['fetch', 'tagBase:H', 'reset:H', 'tag:H'])
  })

  it('is a no-op when the agent is already at hostHead', async () => {
    const { ops, calls } = fakeOps({ commits: 5 })
    const result = await runSyncAlgorithm(ops, {
      hostHead: 'same',
      seedCommit: 'same',
      name: 'a',
      apply: true,
    })
    expect(result).toEqual({
      newSeed: 'same',
      rebased: false,
      commitsReplayed: 0,
      baseCommit: 'same',
      applied: true,
    })
    // Still retags the base: the tag has to exist even for an up-to-date agent, or the agent's own
    // "am I behind?" check has no ref to compare against on a repo that has never fallen behind.
    expect(calls).toEqual(['fetch', 'tagBase:same'])
  })

  it('fast-forwards (reset) when the agent has no commits of its own', async () => {
    const { ops, calls } = fakeOps({ commits: 0 })
    const result = await runSyncAlgorithm(ops, {
      hostHead: 'H',
      seedCommit: 'old',
      name: 'a',
      apply: true,
    })
    expect(result).toEqual({
      newSeed: 'H',
      rebased: false,
      commitsReplayed: 0,
      baseCommit: 'H',
      applied: true,
    })
    expect(calls).toEqual(['fetch', 'tagBase:H', 'reset:H', 'tag:H'])
  })

  it('rebases the agent commits when it has some (clean tree)', async () => {
    const { ops, calls } = fakeOps({ commits: 2, dirty: false })
    const result = await runSyncAlgorithm(ops, {
      hostHead: 'H',
      seedCommit: 'old',
      name: 'a',
      apply: true,
    })
    expect(result).toEqual({
      newSeed: 'H',
      rebased: true,
      commitsReplayed: 2,
      baseCommit: 'H',
      applied: true,
    })
    expect(calls).toEqual(['fetch', 'tagBase:H', 'rebase:H', 'tag:H'])
  })

  it('auto-stashes a dirty tree and pops it after a successful rebase', async () => {
    const { ops, calls } = fakeOps({ commits: 1, dirty: true })
    await runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a', apply: true })
    expect(calls).toEqual(['fetch', 'tagBase:H', 'stash', 'rebase:H', 'tag:H', 'stashPop'])
  })

  it('aborts and restores the stash on a rebase conflict, leaving work intact', async () => {
    const { ops, calls } = fakeOps({ commits: 1, dirty: true, rebaseThrows: true })
    await expect(
      runSyncAlgorithm(ops, {
        hostHead: 'abcdef12',
        seedCommit: 'old',
        name: 'alice',
        apply: true,
      }),
    ).rejects.toThrow(/rebase conflicts onto abcdef12 — aborted, work intact/)
    expect(calls).toEqual([
      'fetch',
      'tagBase:abcdef12',
      'stash',
      'rebase:abcdef12',
      'rebaseAbort',
      'stashPop',
    ])
    // never retagged the seed on the conflict path
    expect(calls).not.toContain('tag:abcdef12')
  })

  it('throws SyncConflictError agentClean=true for a rolled-back rebase (safe to net-merge)', async () => {
    const err = await syncErr(fakeOps({ commits: 1, dirty: true, rebaseThrows: true }).ops)
    expect(err).toBeInstanceOf(SyncConflictError)
    expect(err.agentClean).toBe(true)
  })

  it('throws SyncConflictError agentClean=false when the repo is pre-wedged', async () => {
    const err = await syncErr(fakeOps({ dirty: true, conflict: 'unmerged' }).ops)
    expect(err.agentClean).toBe(false)
  })

  it('throws SyncConflictError agentClean=false when the rebase abort itself fails', async () => {
    const err = await syncErr(
      fakeOps({ commits: 1, dirty: true, rebaseThrows: true, abortFails: true }).ops,
    )
    expect(err.agentClean).toBe(false)
  })

  it('throws SyncConflictError agentClean=false on a post-rebase stash-pop conflict', async () => {
    const err = await syncErr(fakeOps({ commits: 1, dirty: true, stashPopThrows: true }).ops)
    expect(err.agentClean).toBe(false)
  })

  it('swallows a stash-pop failure during abort and still reports the rebase conflict', async () => {
    const { ops } = fakeOps({ commits: 1, dirty: true, rebaseThrows: true, stashPopThrows: true })
    await expect(
      runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a', apply: true }),
    ).rejects.toThrow(/rebase conflicts/)
  })

  it('reports a stash-pop conflict that occurs after a successful rebase', async () => {
    const { ops, calls } = fakeOps({ commits: 1, dirty: true, stashPopThrows: true })
    await expect(
      runSyncAlgorithm(ops, {
        hostHead: 'abcdef12',
        seedCommit: 'old',
        name: 'alice',
        apply: true,
      }),
    ).rejects.toThrow(/synced onto abcdef12, but restoring its uncommitted work hit conflicts/)
    expect(calls).toContain('tag:abcdef12')
  })

  it('fails up front with an actionable error when the repo is mid-rebase, before stashing', async () => {
    const { ops, calls } = fakeOps({ commits: 2, dirty: true, conflict: 'rebase' })
    await expect(
      runSyncAlgorithm(ops, {
        hostHead: 'abcdef12',
        seedCommit: 'old',
        name: 'alice',
        apply: true,
      }),
    ).rejects.toThrow(
      /its repo has a rebase in progress.*quimby sync alice -f.*quimby nudge alice/s,
    )
    // Bailed before the auto-stash — the cryptic "git stash: needs merge" never runs. The base
    // is still DELIVERED first: one ref write is safe even on a wedged repo, and it is what lets
    // the agent see the new base while it resolves.
    expect(calls).toEqual(['fetch', 'tagBase:abcdef12'])
  })

  // The deliver-vs-apply split. Everything above passes `apply: true` because it describes the
  // rewriting algorithm; these describe what a ROUTINE sync now does.
  it('defers instead of rebasing when the agent has commits of its own', async () => {
    const { ops, calls } = fakeOps({ commits: 3 })
    const result = await runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a' })
    expect(result).toEqual({
      newSeed: 'old',
      rebased: false,
      commitsReplayed: 3,
      baseCommit: 'H',
      applied: false,
      deferred: 'commits',
    })
    // Delivered and nothing else: no rebase (its SHAs would change under it), no reseed.
    expect(calls).toEqual(['fetch', 'tagBase:H'])
  })

  // The silent-revert hole this whole split exists to close: the old path stashed the agent's
  // pre-sync tree and popped it back over work that had just landed, and a CLEAN pop reinstated
  // stale copies with no conflict and no signal.
  it('never stashes a dirty tree on the routine path', async () => {
    const { ops, calls } = fakeOps({ commits: 0, dirty: true })
    const result = await runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a' })
    expect(result.applied).toBe(false)
    expect(result.deferred).toBe('dirty')
    expect(calls).not.toContain('stash')
    expect(calls).not.toContain('stashPop')
  })

  // The one advance that is not a rewrite: no commits to replay and nothing to stash, so HEAD
  // moves to a descendant and no SHA the agent may have recorded changes meaning.
  it('still fast-forwards a clean agent with no commits, without opting in', async () => {
    const { ops, calls } = fakeOps({ commits: 0, dirty: false })
    const result = await runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a' })
    expect(result.applied).toBe(true)
    expect(result.deferred).toBeUndefined()
    expect(calls).toEqual(['fetch', 'tagBase:H', 'reset:H', 'tag:H'])
  })

  it('leaves the seed where it was when it defers, so the agent is still behind', async () => {
    const { ops } = fakeOps({ commits: 2, dirty: true })
    const result = await runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a' })
    expect(result.newSeed).toBe('old')
    expect(result.baseCommit).toBe('H')
  })

  it('names a merge in progress and unmerged paths distinctly in the up-front error', async () => {
    await expect(
      runSyncAlgorithm(fakeOps({ dirty: true, conflict: 'merge' }).ops, {
        hostHead: 'H',
        seedCommit: 'old',
        name: 'a',
      }),
    ).rejects.toThrow(/a merge in progress/)
    await expect(
      runSyncAlgorithm(fakeOps({ dirty: true, conflict: 'unmerged' }).ops, {
        hostHead: 'H',
        seedCommit: 'old',
        name: 'a',
      }),
    ).rejects.toThrow(/unmerged paths/)
  })

  it('reports loudly when the rebase abort itself fails, leaving the repo mid-rebase', async () => {
    const { ops } = fakeOps({ commits: 1, dirty: true, rebaseThrows: true, abortFails: true })
    await expect(
      runSyncAlgorithm(ops, {
        hostHead: 'abcdef12',
        seedCommit: 'old',
        name: 'alice',
        apply: true,
      }),
    ).rejects.toThrow(/the automatic abort failed — its repo is left mid-rebase/)
  })

  it('does not pop the stash when the abort failed (tree is still mid-rebase)', async () => {
    const { ops, calls } = fakeOps({
      commits: 1,
      dirty: true,
      rebaseThrows: true,
      abortFails: true,
    })
    await expect(
      runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a', apply: true }),
    ).rejects.toThrow(/abort failed/)
    expect(calls).not.toContain('stashPop')
  })

  it('does not stash a clean tree', async () => {
    const { ops, calls } = fakeOps({ commits: 1, dirty: false })
    await runSyncAlgorithm(ops, { hostHead: 'H', seedCommit: 'old', name: 'a', apply: true })
    expect(calls).not.toContain('stash')
    expect(calls).not.toContain('stashPop')
  })
})
