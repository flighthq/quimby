import { describeSyncDeferral, syncAgents } from '@quimbyhq/agent'
import * as git from '@quimbyhq/git'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'

export interface BaseTipTracker {
  /** syncRef → the host tip last seen for it, or `UNRESOLVED_TIP`. */
  tips: Map<string, string>
}

/**
 * Deliver the base to every agent when the host repo's tip moves under them.
 *
 * Nothing else in the running system watches the host repo, so before this the base moved only
 * when a human typed `quimby sync` — a fleet whose work lands through one integration agent then
 * sits waiting on a base that is already merged, with no signal that anything is owed to it.
 *
 * It never rewrites an agent: `force` and `apply` are both pinned false, so this is the ordinary
 * deferring sync — it moves the `quimby/base` tag (one ref write, touching neither HEAD, the index,
 * nor the working tree) and fast-forwards only an agent with a clean tree and no commits of its
 * own. An agent with work in flight is reported as `delivered` and applies the base itself with
 * `./agent.sh rebase`, when its tree is at a point only it can recognise. That is what makes this
 * safe to run unattended, and it is why the two rewriting flags are absent rather than optional.
 *
 * Returns the refs it delivered for, empty when nothing moved.
 */
export async function autoDeliverMovedBase(
  repoRoot: string,
  state: Readonly<QuimbyState>,
  tracker: BaseTipTracker,
  reporter: Readonly<Reporter>,
): Promise<readonly string[]> {
  const refs = getWatchedSyncRefs(state)
  // Drop refs nothing tracks any more (an agent removed, or retargeted with `sync --base`), so a
  // long-running server's map stays the size of the fleet rather than of its whole history.
  for (const ref of [...tracker.tips.keys()]) {
    if (!refs.includes(ref)) tracker.tips.delete(ref)
  }
  if (refs.length === 0) return []

  const moved = new Map<string, string>()
  const descriptors: string[] = []
  for (const ref of refs) {
    const tip = await git.revParse(repoRoot, ref).catch(() => UNRESOLVED_TIP)
    const previous = tracker.tips.get(ref)
    if (previous === tip) continue
    if (tip === UNRESOLVED_TIP) {
      // Recorded now so this is said once, on the transition, rather than every poll cycle. A ref
      // that stops resolving would otherwise just stop delivering, and a watcher that silently
      // does nothing is the exact failure this exists to remove.
      tracker.tips.set(ref, tip)
      reporter.warn(
        `Base watch: "${ref}" no longer resolves in the host repo — not delivering it. ` +
          'Retarget the agents on it with `quimby sync <agent> --base <ref>`.',
      )
      continue
    }
    moved.set(ref, tip)
    // A first sighting is delivered too, not just recorded. The alternative leaves a tip that moved
    // while the server was down invisible until it happens to move again — which may be never, and
    // is the common shape of the staleness this watches for (merge, then start the server). The
    // sync is idempotent, so the cost when the fleet is already current is a no-op per agent.
    descriptors.push(
      previous === undefined
        ? `${ref} @ ${tip.slice(0, 8)} (startup)`
        : `${ref} → ${tip.slice(0, 8)}`,
    )
  }
  if (moved.size === 0) return []

  const count = Object.keys(state.agents).length
  reporter.info(`Base watch: ${descriptors.join(', ')} — delivering to ${count} agent(s)`)

  let outcomes
  try {
    // Narrated from the outcomes below rather than by `syncAgents` itself: a fleet that is already
    // current would otherwise print a line per agent saying so on every base move.
    outcomes = await syncAgents(
      { state, repoRoot, names: [], all: true, force: false, apply: false, current: false },
      silentReporter,
    )
  } catch (err) {
    // Tips stay unrecorded, so the next cycle retries rather than treating a failed delivery as done.
    reporter.error(`Base watch: delivery failed — ${err instanceof Error ? err.message : err}`)
    return []
  }
  for (const [ref, tip] of moved) tracker.tips.set(ref, tip)

  // Condensing the success path must not condense away a miss: an agent that still owes itself the
  // advance, and one whose sync failed, are each named, while the agents that simply landed on the
  // new base are a count.
  const deferred = outcomes.filter((outcome) => outcome.outcome === 'delivered')
  const skipped = outcomes.filter((outcome) => outcome.outcome === 'skipped')
  reporter.success(
    `Base delivered to ${outcomes.length - skipped.length} agent(s)` +
      (deferred.length > 0 ? `, ${deferred.length} to apply it themselves` : ''),
  )
  for (const outcome of deferred) {
    reporter.info(
      `[${outcome.name}] base delivered (${outcome.baseCommit?.slice(0, 8)}) — not applied, ` +
        describeSyncDeferral(outcome.name, outcome.deferred, outcome.commitsReplayed),
    )
  }
  for (const outcome of skipped) {
    reporter.warn(`[${outcome.name}] base delivered, sync skipped — ${outcome.error}`)
  }
  return [...moved.keys()]
}

export function createBaseTipTracker(): BaseTipTracker {
  return { tips: new Map() }
}

/** Every distinct ref the fleet tracks — an agent's own `syncRef`, else the workspace default. */
export function getWatchedSyncRefs(state: Readonly<QuimbyState>): string[] {
  const refs = new Set<string>()
  for (const agent of Object.values(state.agents)) refs.add(agent.syncRef ?? state.sourceRef)
  return [...refs].sort()
}

/** Tip stored for a syncRef the host repo cannot resolve (deleted branch, unborn HEAD). */
const UNRESOLVED_TIP = ''
