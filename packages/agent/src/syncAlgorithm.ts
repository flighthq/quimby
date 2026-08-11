import { SyncConflictError } from '@quimbyhq/errors'

/** A pre-existing conflicted state the safe sync's auto-stash cannot proceed over. */
export type SyncConflictState = 'merge' | 'rebase' | 'unmerged'

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
  /**
   * The commit the agent's OWN `quimby/seed` tag points at, or null when it cannot be read.
   *
   * The agent is the authority on this now. Since it applies the delivered base itself, it also
   * advances its own seed — so host state can be a day behind reality, and believing host state
   * makes quimby insist on a rebase the agent already did, while every capture measures against
   * the stale baseline and carries the peers' landed work as the agent's own.
   */
  resolveSeedCommit(): Promise<string | null>
  /**
   * Whether the agent's HEAD already contains `commit` — the ground truth for "has this base been
   * applied?", independent of any tag.
   *
   * Needed because a tag can be stale for reasons the agent cannot fix: an agent that applied its
   * base under an older `agent.sh` never advanced its seed, and re-running the apply is a no-op
   * (it IS on the base), so the seed can never catch up on its own. The host would then insist on
   * a rebase forever while the agent correctly answered "already up to date". Asking git what HEAD
   * contains breaks that deadlock and lets the host repair the tag.
   */
  containsCommit(commit: string): Promise<boolean>
  /**
   * The kind of unresolved conflict already sitting in the repo (an in-progress merge/rebase, or
   * unmerged index entries), or null when the tree is clean enough to stash. `git stash` refuses
   * while any of these exist, so the safe sync checks this before its auto-stash step and fails
   * with a clear error rather than a cryptic "needs merge".
   */
  pendingConflictState(): Promise<SyncConflictState | null>
  isDirty(): Promise<boolean>
  stash(): Promise<void>
  resetHardTo(commit: string): Promise<void>
  /**
   * Advance to `commit` without overwriting the working tree: true when it fast-forwarded, false
   * when git refused because local changes would be lost.
   *
   * The routine path uses this rather than {@link resetHardTo} because `isDirty()` followed by a
   * hard reset is check-then-act against a LIVE process. An edit the agent writes in that gap is
   * destroyed with no trace — the file matches HEAD, `git status` is clean, and the mtime is git's
   * own write, so every dirt-based detector reads it as "nothing happened". Letting git make the
   * check itself, under its index lock, is the only way to close the window rather than narrow it.
   */
  fastForwardTo(commit: string): Promise<boolean>
  /** Rebase the agent's commits onto `commit`; rejects on conflict. */
  rebaseOnto(commit: string): Promise<void>
  /**
   * Abort an in-progress rebase. Resolves `true` when the repo is left clean of the rebase,
   * `false` when the abort itself failed (the repo is still mid-rebase) — the caller reports that
   * loudly rather than swallowing it, since a silently-failed abort is how a repo gets wedged.
   */
  rebaseAbort(): Promise<boolean>
  /** Move the `quimby/seed` tag to `commit`. */
  tagSeed(commit: string): Promise<void>
  /**
   * Move the `quimby/base` tag to `commit` — the DELIVERY half of a sync, and the only step that
   * is unconditionally safe. It writes one ref and touches neither HEAD, the index, nor the
   * working tree, so it cannot disturb in-flight work and runs even for an agent whose repo is
   * wedged. The agent applies it on its own schedule.
   */
  tagBase(commit: string): Promise<void>
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
  /**
   * Rewrite the agent's history when that is what advancing takes — stash a dirty tree and rebase
   * its commits, the pre-split behavior. Off by default: a routine sync DELIVERS the base and lets
   * the agent apply it. Callers that are a deliberate, user-present act on work being harvested
   * right now (`merge`'s pre-sync) opt in.
   */
  apply?: boolean
  /** Agent name, for the conflict error messages. */
  name: string
}

/** Why an advance was left for the agent to apply rather than done under it. */
export type SyncDeferReason = 'commits' | 'dirty' | 'diverged'

export interface SyncAlgorithmResult {
  newSeed: string
  rebased: boolean
  commitsReplayed: number
  /** What `quimby/base` now points at — delivered whether or not the agent was advanced onto it. */
  baseCommit: string
  /** Whether the agent's HEAD actually moved onto `baseCommit`. */
  applied: boolean
  /**
   * The agent was ALREADY on the base when this sync ran — it applied the delivered base itself,
   * and this call only caught host state up. Nothing in the agent's repo moved.
   *
   * Reported separately because otherwise it is indistinguishable from a fast-forward this command
   * performed, and that ambiguity is actively misleading: a sweep says "base delivered, not
   * applied", the agent applies it seconds later off the footer notice, and the next single sync
   * announces "fast-forwarded" — so the sweep looks broken and the single sync looks like the fix,
   * when neither did the work.
   */
  reconciled?: boolean
  /** Set when the advance was deferred to the agent; `applied` is then false. */
  deferred?: SyncDeferReason
}

/**
 * Bring an agent's repo onto `hostHead`, keeping its work by default: auto-stash a dirty
 * tree, rebase its commits (or fast-forward when it has none), retag the seed, then pop
 * the stash. `force` hard-resets instead. A rebase conflict aborts and restores the
 * stash, leaving the work intact; a stash-pop conflict after a successful rebase reports
 * so the user can resolve on the agent. Both surface as a `SyncConflictError`, whose
 * `agentClean` flag says whether the repo is left clean (a rolled-back rebase) so a caller
 * with a more lenient conflict test can proceed, versus wedged and needing resolution first.
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

  // DELIVER FIRST, unconditionally. This is one ref write — it cannot disturb in-flight work, so
  // it happens before every decision below and even on the paths that throw. It also means the tag
  // exists from the first sync onward, so the agent's own "am I behind?" check never has to cope
  // with a missing ref.
  await ops.tagBase(hostHead)

  if (input.force) {
    await ops.resetHardTo(hostHead)
    await ops.tagSeed(hostHead)
    return {
      newSeed: hostHead,
      rebased: false,
      commitsReplayed: 0,
      baseCommit: hostHead,
      applied: true,
    }
  }

  // Reconcile against the agent's OWN seed before deciding anything. When the agent applied the
  // delivered base itself (`./agent.sh rebase`), it advanced its seed and host state did not — so
  // the host would otherwise compute a large `behind`, offer a rebase the agent has already done,
  // and disagree with the agent to its face. Reading the agent's tag makes host state follow the
  // reality it no longer controls.
  const agentSeed = await ops.resolveSeedCommit()
  // `containsCommit` is the ground truth and the last of the three, because it is the only one that
  // survives a stale tag. An agent that applied its base under an older tool has HEAD containing
  // the base while its seed still points a day back — and re-applying is a no-op, so it can never
  // fix itself. Without this the host nudges forever and the agent correctly answers "already up to
  // date" forever; observed twice before it was diagnosed.
  if (
    hostHead === input.seedCommit ||
    hostHead === agentSeed ||
    (await ops.containsCommit(hostHead))
  ) {
    // Repair the tag while we are here — one ref write, and leaving it stale keeps every capture
    // measured against the wrong baseline even though the agent is current. Only on a seed we
    // actually READ and found different: a null means unreadable, which is not evidence of
    // staleness and not a reason to write to the agent's repo.
    if (agentSeed !== null && agentSeed !== hostHead) await ops.tagSeed(hostHead)
    return {
      newSeed: hostHead,
      rebased: false,
      commitsReplayed: 0,
      baseCommit: hostHead,
      applied: true,
      // Host state disagreed and the agent was right: it had already applied this base. Say so,
      // rather than let it read as an advance this call performed.
      reconciled: hostHead !== input.seedCommit,
    }
  }

  // A pre-existing conflicted state (in-progress merge/rebase, or unmerged index) makes the
  // auto-stash below die with a cryptic "needs merge". Detect it up front and fail with a clear,
  // actionable error — the safe sync can't proceed over unresolved conflicts. `-f` (which resets
  // hard, clearing the state) returned above, so this only ever gates the work-preserving path.
  const conflict = await ops.pendingConflictState()
  if (conflict) {
    // Pre-wedged: the working tree already carries conflict markers / an in-progress op, so it is
    // NOT safe to capture — `agentClean: false`.
    throw new SyncConflictError(syncConflictMessage(name, hostHead, conflict), false)
  }

  const commitsReplayed = await ops.countCommitsSinceSeed()
  const dirty = await ops.isDirty()

  // The split. Advancing an agent that has NO commits and a clean tree is a fast-forward: nothing
  // of the agent's is rewritten, no SHA it may have recorded (a `quimby-attest` atCommit, a parcel's
  // CommitMeta) changes meaning, and there is no stash. That case stays automatic.
  //
  // Anything else means rewriting the agent's history or restoring its work over a moved base, and
  // the host cannot tell whether now is a safe moment: `isDirty()` reads the same for "my formatter
  // touched twelve files" and "I am three edits into a refactor". So it is deferred. The base is
  // already delivered above; the agent applies it at a boundary it recognises.
  //
  // This is what closes the silent-revert hole. The old path stashed (`--include-untracked`),
  // rebased, then popped — and a CLEAN pop reinstates the agent's pre-sync copies on top of work
  // that just landed, with no conflict and no signal, so the agent could commit a revert of a
  // peer's work inside an unrelated commit. No stash, no resurrection.
  if (!input.apply && (commitsReplayed > 0 || dirty)) {
    return {
      newSeed: input.seedCommit ?? hostHead,
      rebased: false,
      commitsReplayed,
      baseCommit: hostHead,
      applied: false,
      deferred: commitsReplayed > 0 ? 'commits' : 'dirty',
    }
  }

  if (dirty) await ops.stash()

  if (commitsReplayed === 0) {
    // The routine advance is a FAST-FORWARD, not a hard reset. `isDirty()` above was read from a
    // live, concurrently-editing process, so by now it may be stale: an edit written between that
    // read and this line would be silently destroyed by a reset, leaving a file matching HEAD, a
    // clean status and git's own mtime — invisible to every dirt-based check. Fast-forward makes
    // git re-check under its index lock and refuse, and a refusal simply becomes the deferral we
    // would have chosen had we seen the edit in time.
    //
    // `apply` mode stashed above precisely so it can overwrite, and `force` returned much earlier,
    // so neither reaches here.
    if (!(await ops.fastForwardTo(hostHead))) {
      // Two different refusals wear the same exit code: local changes would be overwritten (the
      // race we just avoided), or the target is not a descendant at all (a rewritten/force-pushed
      // branch). Re-reading dirtiness separates them, because reporting a diverged base as
      // "uncommitted work" would send the user looking for work that isn't there.
      return {
        newSeed: input.seedCommit ?? hostHead,
        rebased: false,
        commitsReplayed,
        baseCommit: hostHead,
        applied: false,
        deferred: (await ops.isDirty()) ? 'dirty' : 'diverged',
      }
    }
  } else {
    try {
      await ops.rebaseOnto(hostHead)
    } catch {
      const aborted = await ops.rebaseAbort()
      if (dirty && aborted) await ops.stashPop().catch(() => {})

      // `git rebase` also refuses outright on an unstaged change, so a rebase that fails when we
      // did NOT stash (the tree read clean moments earlier) is not a conflict at all — the agent
      // wrote to its tree while the sync was running. Saying "rebase conflicts" there sends the
      // user to resolve a conflict that does not exist, and hides the fact that the agent is live.
      if (!dirty && aborted && (await ops.isDirty())) {
        throw new SyncConflictError(
          `Agent "${name}" changed its working tree while syncing onto ${hostHead.slice(0, 8)}, so the ` +
            `rebase could not run — nothing was lost and its repo is untouched. Re-run once it is idle, ` +
            `or have it commit first ("./agent.sh rebase" applies the base itself).`,
          true,
        )
      }
      // A clean abort leaves the repo back on its seed, work intact (`agentClean: true`), so a
      // caller whose own conflict test is more lenient — `merge`'s 3-way of the net change — can
      // proceed from the seed. A failed abort leaves it mid-rebase, so it is not clean.
      throw new SyncConflictError(
        aborted
          ? `Agent "${name}" has rebase conflicts onto ${hostHead.slice(0, 8)} — aborted, work intact. ` +
              `Resolve them on the agent, or "quimby sync ${name} -f" to force to the base (discards the agent's commits).`
          : `Agent "${name}" hit rebase conflicts onto ${hostHead.slice(0, 8)} and the automatic abort failed — ` +
              `its repo is left mid-rebase. Resolve it on the agent ("git rebase --abort" in repo/), or ` +
              `"quimby sync ${name} -f" to hard-reset to the base (discards the agent's commits, keeps its mailbox).`,
        aborted,
      )
    }
  }

  await ops.tagSeed(hostHead)
  if (dirty) {
    try {
      await ops.stashPop()
    } catch {
      // The seed already advanced and the popped stash left markers in the tree — not clean.
      throw new SyncConflictError(
        `Agent "${name}" synced onto ${hostHead.slice(0, 8)}, but restoring its uncommitted work hit conflicts — resolve them on the agent.`,
        false,
      )
    }
  }

  return {
    newSeed: hostHead,
    rebased: commitsReplayed > 0,
    commitsReplayed,
    baseCommit: hostHead,
    applied: true,
  }
}

/**
 * The actionable error for a repo already wedged in an unresolved conflict when a safe sync
 * begins. Names what's blocking (merge / rebase / unmerged paths), the on-agent undo, the `-f`
 * hard-reset escape hatch, and a ready-to-paste `quimby nudge` to wake the agent to resolve it —
 * surfacing the choice to the user rather than auto-nudging (which sync deliberately never does).
 */
function syncConflictMessage(name: string, hostHead: string, state: SyncConflictState): string {
  const blocking =
    state === 'merge'
      ? 'a merge in progress'
      : state === 'rebase'
        ? 'a rebase in progress'
        : 'unmerged paths (an unresolved conflict)'
  const undo =
    state === 'merge'
      ? 'git merge --abort'
      : state === 'rebase'
        ? 'git rebase --abort'
        : 'git merge --abort or git rebase --abort'
  return (
    `Agent "${name}" can't sync onto ${hostHead.slice(0, 8)}: its repo has ${blocking}, so the safe sync ` +
    `can't stash over it. Resolve it on the agent (run "${undo}" in repo/, or finish the conflict), then ` +
    `re-run — or "quimby sync ${name} -f" to hard-reset to the base (discards the agent's work, keeps its ` +
    `mailbox). To wake the agent to resolve it: quimby nudge ${name} -m "resolve the git conflict in repo/ — ` +
    `run git status, then abort or commit".`
  )
}
