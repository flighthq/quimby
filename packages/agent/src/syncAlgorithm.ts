import { QuimbyError } from '@quimbyhq/errors'

/**
 * The git operations the sync algorithm needs, abstracted over the backend so the same
 * algorithm drives a local agent (via the git CLI) and an SSH agent (via remote `git`
 * over transport). Adapters are thin forwarders; the branching logic lives once in
 * {@link runSyncAlgorithm} and is testable against a fake implementation.
 */
export interface RepoSyncOps {
  fetch(): Promise<void>
  /** Number of commits the agent has made past its seed (`quimby/seed..HEAD`). */
  countCommitsSinceSeed(): Promise<number>
  isDirty(): Promise<boolean>
  stash(): Promise<void>
  resetHardTo(commit: string): Promise<void>
  /** Rebase the agent's commits onto `commit`; rejects on conflict. */
  rebaseOnto(commit: string): Promise<void>
  rebaseAbort(): Promise<void>
  /** Move the `quimby/seed` tag to `commit`. */
  tagSeed(commit: string): Promise<void>
  /** Restore auto-stashed work; rejects on conflict. */
  stashPop(): Promise<void>
}

export interface SyncAlgorithmInput {
  /** The commit to advance onto (the syncRef tip, resolved in the host repo). */
  hostHead: string
  /** The agent's current seed; when it equals hostHead the agent is already current. */
  seedCommit?: string
  /** Hard-reset to hostHead, discarding the agent's commits + working changes. */
  force?: boolean
  /** Agent name, for the conflict error messages. */
  name: string
}

export interface SyncAlgorithmResult {
  newSeed: string
  rebased: boolean
  commitsReplayed: number
}

/**
 * Bring an agent's repo onto `hostHead`, keeping its work by default: auto-stash a dirty
 * tree, rebase its commits (or fast-forward when it has none), retag the seed, then pop
 * the stash. `force` hard-resets instead. A rebase conflict aborts and restores the
 * stash, leaving the work intact; a stash-pop conflict after a successful rebase reports
 * so the user can resolve on the agent. Both surface as a `QuimbyError`.
 *
 * Pure orchestration over {@link RepoSyncOps} — no git or transport imports — so every
 * branch is unit-testable with a fake backend.
 */
export async function runSyncAlgorithm(
  ops: RepoSyncOps,
  input: Readonly<SyncAlgorithmInput>,
): Promise<SyncAlgorithmResult> {
  const { hostHead, name } = input
  await ops.fetch()

  if (input.force) {
    await ops.resetHardTo(hostHead)
    await ops.tagSeed(hostHead)
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  if (hostHead === input.seedCommit) {
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  const commitsReplayed = await ops.countCommitsSinceSeed()
  const dirty = await ops.isDirty()
  if (dirty) await ops.stash()

  if (commitsReplayed === 0) {
    await ops.resetHardTo(hostHead)
  } else {
    try {
      await ops.rebaseOnto(hostHead)
    } catch {
      await ops.rebaseAbort()
      if (dirty) await ops.stashPop().catch(() => {})
      throw new QuimbyError(
        `Agent "${name}" has rebase conflicts onto ${hostHead.slice(0, 8)} — aborted, work intact. ` +
          `Resolve them on the agent, or "quimby sync ${name} -f" to force to the base (discards the agent's commits).`,
      )
    }
  }

  await ops.tagSeed(hostHead)
  if (dirty) {
    try {
      await ops.stashPop()
    } catch {
      throw new QuimbyError(
        `Agent "${name}" synced onto ${hostHead.slice(0, 8)}, but restoring its uncommitted work hit conflicts — resolve them on the agent.`,
      )
    }
  }

  return { newSeed: hostHead, rebased: commitsReplayed > 0, commitsReplayed }
}
