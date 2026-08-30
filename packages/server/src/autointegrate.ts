import { getAgentWorkSummary, rebaseAgentOntoBase, syncAgent } from '@quimbyhq/agent'
import { ConflictError, HandoffError, SyncConflictError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import {
  applyHandoff,
  discardHandoff,
  getWorkingParcelName,
  healAbandonedStaging,
  stageParcel,
} from '@quimbyhq/handoff'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { nudgeAgentSession } from '@quimbyhq/session'
import { renderResolveConflictRequest } from '@quimbyhq/template'
import type { QuimbyState } from '@quimbyhq/types'

export interface IntegratePolicy {
  /** The agent whose committed work is pulled across the boundary. */
  from: string
  /** Land here instead of the branch the agent tracks (no seed advance, exactly like `merge -b`). */
  branch?: string
}

export interface IntegrateTracker {
  /**
   * The agent tree already attempted, as its content-hashed parcel name — so one tree is carried at
   * most once however many cycles pass.
   *
   * Attempt-once is keyed on the TREE rather than on success, because the two failures that matter
   * both leave the tree unchanged: a genuine conflict, and a wedged repo. Retrying either every
   * five seconds would re-nudge the agent in a loop over a state only it can clear. A tree that
   * changes is new work, and is attempted afresh.
   */
  lastAttempt: string | null
}

/**
 * Pull one agent's committed work across the boundary when it has committed something new — the
 * automated twin of `quimby merge <agent> --commits`, run on the poll cycle when a workspace
 * declares `integrate:`.
 *
 * This is the one server behavior that writes the user's real repository, so three constraints hold
 * it in. **The mode is pinned to `commits`**, not configurable: it is the only mode that is
 * idempotent (patch-id deduped, so a re-gather lands nothing new), never fabricates a commit
 * message, and leaves the uncommitted remainder on the agent — which is also what lets it pull from
 * a worker that is still typing. Squashed would want an editor there is no terminal for, and would
 * degrade to dropping the work loose in the user's tree. **A conflict never leaves the host
 * mid-merge**: the tentative merge is aborted, the parcel discarded, and resolution routed back to
 * the agent, which has the code context. **One tree is attempted once**, so neither a conflict nor
 * a wedged agent becomes a nudge loop.
 *
 * Returns how many commits actually landed. Zero covers "nothing to do", "nothing new crossed", and
 * "it conflicted" — which the reporting distinguishes, since a quiet no-op and a refusal must not
 * read alike.
 */
export async function autoIntegrateWork(
  repoRoot: string,
  state: Readonly<QuimbyState>,
  policy: Readonly<IntegratePolicy>,
  tracker: IntegrateTracker,
  reporter: Readonly<Reporter>,
): Promise<number> {
  const agent = state.agents[policy.from]
  if (!agent) {
    // Naming this every cycle would be spam, so it rides the same attempt-once slot: reported once,
    // and not again until the roster or the tree changes.
    if (tracker.lastAttempt !== MISSING_AGENT) {
      tracker.lastAttempt = MISSING_AGENT
      reporter.warn(
        `integrate: no agent named "${policy.from}" — nothing is being integrated. ` +
          'Fix the `from:` in your config, or create it with `quimby add`.',
      )
    }
    return 0
  }

  // `commits` mode carries only committed work, so an agent with none has nothing to land and there
  // is no reason to stage a parcel to discover that. This is also the steady state: right after a
  // successful integration the seed has advanced past everything, so the count is 0 again.
  const summary = await getAgentWorkSummary(repoRoot, state.id, agent).catch(() => null)
  if (!summary || summary.commits === 0) return 0

  const parcelName = await getWorkingParcelName({
    repoRoot,
    from: policy.from,
    codeSourceId: agent.id,
    location: agent.location,
    projectId: state.id,
  }).catch(() => null)
  if (parcelName && parcelName === tracker.lastAttempt) return 0

  // The target has to be clean to merge into, and it is the user's own repo — so this reports and
  // waits rather than touching their uncommitted work.
  if (!(await git.isClean(repoRoot).catch(() => false))) {
    if (tracker.lastAttempt !== DIRTY_HOST) {
      tracker.lastAttempt = DIRTY_HOST
      reporter.warn(
        `integrate: "${policy.from}" has ${summary.commits} commit(s) to land, but your repo has ` +
          'uncommitted changes — commit or stash them and it lands on the next cycle.',
      )
    }
    return 0
  }
  // The dirty host cleared: drop the sentinel so the tree key governs again.
  if (tracker.lastAttempt === DIRTY_HOST) tracker.lastAttempt = null

  const syncRef = agent.syncRef ?? state.sourceRef
  reporter.info(
    `Integrating "${policy.from}" — ${summary.commits} commit(s) since its seed (commits mode)`,
  )
  tracker.lastAttempt = parcelName

  await healAbandonedStaging(repoRoot, repoRoot).catch(() => {})

  // The pre-sync, exactly as `merge` runs it: bring the agent onto the branch being merged into
  // before capturing its diff, so base-drift conflicts surface as a rebase in the agent's own clone
  // (rolled back there, work intact) instead of a merge left in the user's repo. A clean rollback
  // is NOT fatal — a per-commit replay is a stricter test than the net 3-way about to run — so it
  // falls through and lets the boundary merge decide. Only a wedged repo stops here.
  let presyncFellBack = false
  try {
    await rebaseAgentOntoBase(repoRoot, policy.from, silentReporter)
  } catch (err) {
    if (!(err instanceof SyncConflictError)) throw err
    if (!err.agentClean) {
      reporter.warn(
        `integrate: "${policy.from}" repo is wedged (${err.message}) — nothing merged. It has to ` +
          'clear that itself; nothing retries until its tree changes.',
      )
      await requestConflictResolution(state, policy.from, syncRef, reporter)
      return 0
    }
    presyncFellBack = true
  }

  let name: string
  try {
    name = (await stageParcel({ state, repoRoot, from: policy.from })).name
  } catch (err) {
    // The pre-sync already brought it onto its base, so there is nothing left to carry — an
    // integrated agent, not a failure.
    if (err instanceof HandoffError) return 0
    throw err
  }

  try {
    const result = await applyHandoff({
      repoRoot,
      name,
      targetRepoPath: repoRoot,
      mode: 'commits',
      branch: policy.branch,
    })
    await discardHandoff(repoRoot, name)

    if (result.landedCommits === 0) {
      reporter.info(`integrate: nothing landed from "${policy.from}" — the target already had it`)
      return 0
    }
    reporter.success(
      `Integrated "${policy.from}" into ${policy.branch ?? syncRef} (${result.landedCommits} commit(s))`,
    )
    if (result.unpulledRemainderFiles > 0) {
      reporter.info(
        `${result.unpulledRemainderFiles} uncommitted file(s) left on "${policy.from}" — not ` +
          'pulled, so it keeps working uninterrupted.',
      )
    }
    await advanceIntegratorSeed(repoRoot, state, policy, syncRef, presyncFellBack, reporter)
    return result.landedCommits
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err
    // Never leave the user's repo mid-merge unattended: undo the tentative merge so the working
    // tree is exactly as it was, drop the parcel, and route resolution to the agent — the same
    // guarantee the pre-sync gives, honored for the one overlap the fallback could not dissolve.
    if (await git.isMergeInProgress(repoRoot).catch(() => false)) {
      await git.mergeAbort(repoRoot).catch(() => {})
    }
    await discardHandoff(repoRoot, name).catch(() => {})
    reporter.warn(
      `integrate: "${policy.from}" conflicts with ${syncRef} — nothing merged, your repo is ` +
        `untouched. Conflicted: ${err.conflicts.join(', ')}`,
    )
    await requestConflictResolution(state, policy.from, syncRef, reporter)
    return 0
  }
}

export function createIntegrateTracker(): IntegrateTracker {
  return { lastAttempt: null }
}

/**
 * Advance the integrator's seed past what just landed, so its next parcel carries only new work
 * instead of re-proposing everything already merged.
 *
 * Soft (work-preserving) always: `commits` mode leaves the uncommitted remainder on the agent, so a
 * hard reset would discard work the merge deliberately did not take. Gated the way `merge`'s own
 * post-advance is — a landing branch, or a HEAD that is not the agent's tracked tip, means the work
 * is not on `syncRef` and advancing would snap the agent onto a base that lacks it.
 */
async function advanceIntegratorSeed(
  repoRoot: string,
  state: Readonly<QuimbyState>,
  policy: Readonly<IntegratePolicy>,
  syncRef: string,
  presyncFellBack: boolean,
  reporter: Readonly<Reporter>,
): Promise<void> {
  if (policy.branch || presyncFellBack) {
    reporter.info(
      `Seed left unchanged (${policy.branch ? `landed on ${policy.branch}` : 'pre-sync fell back'}) — ` +
        `catch "${policy.from}" up with \`quimby sync ${policy.from} --current -f\` when convenient.`,
    )
    return
  }
  const [tip, head] = await Promise.all([
    git.revParse(repoRoot, syncRef).catch(() => null),
    git.revParse(repoRoot, 'HEAD').catch(() => null),
  ])
  if (tip === null || tip !== head) {
    reporter.info(
      `Merge isn't on "${policy.from}"'s tracked branch (${syncRef}) — left its seed alone.`,
    )
    return
  }
  try {
    const result = await syncAgent(repoRoot, policy.from, { force: false, apply: true })
    reporter.success(
      `Advanced "${policy.from}" seed to ${result.newSeed.slice(0, 8)} (kept its loose work)`,
    )
  } catch (err) {
    // The landing already happened and is safe; a failed advance only costs a fatter next parcel.
    reporter.warn(
      `Landed, but couldn't advance "${policy.from}" seed — ` +
        `${err instanceof Error ? err.message : err}. Catch it up with ` +
        `\`quimby sync ${policy.from} --current -f\`.`,
    )
  }
}

/**
 * Hand the agent the "rebase onto `origin/<ref>` and resolve conflicts" request, forced past the
 * focus guard. A conflict nudge is never held: it is the direct product of the merge that just
 * failed, and it is the only thing that tells the agent what is now blocking the fleet.
 */
async function requestConflictResolution(
  state: Readonly<QuimbyState>,
  name: string,
  syncRef: string,
  reporter: Readonly<Reporter>,
): Promise<void> {
  const outcome = await nudgeAgentSession({
    agent: state.agents[name],
    displayName: name,
    courier: renderResolveConflictRequest(syncRef),
    force: true,
    projectId: state.id,
  }).catch(() => 'no-session' as const)
  if (outcome !== 'sent') {
    reporter.info(
      `"${name}" has no live session to tell — start it, or resolve from the host with ` +
        `\`quimby sync ${name} --apply\`.`,
    )
  }
}

/** Attempt-slot sentinels: states reported once, spelled so they can never be a real parcel name. */
const MISSING_AGENT = ' missing-agent'
const DIRTY_HOST = ' dirty-host'
