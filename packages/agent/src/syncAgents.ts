import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'

import { syncAgent } from './sync'
import type { SyncDeferReason } from './syncAlgorithm'

export interface SyncAgentsOptions {
  state: Readonly<QuimbyState>
  repoRoot: string
  names: readonly string[]
  all: boolean
  force: boolean
  /**
   * Rebase the agent onto the base from the host instead of deferring — stash, replay its commits,
   * pop. The work-preserving counterpart to `force`, which discards.
   *
   * A routine sync defers because the host cannot tell a safe moment from an unsafe one, and the
   * stash/pop it avoids is how a pre-sync copy silently gets reinstated over a peer's landed work.
   * That reasoning is about a BACKGROUND sync; a user typing this is the same deliberate,
   * user-present act that `merge`'s pre-sync already opts in for. Without it the only escape from a
   * stuck agent was `-f` (discards) or running `merge` for its side effect.
   */
  apply: boolean
  base?: string
  current: boolean
}

export interface SyncAgentOutcome {
  name: string
  /**
   * `delivered` is the deliver-without-applying outcome: `quimby/base` moved, the agent's history
   * did not. It is deliberately NOT folded into `up-to-date` — the agent is still behind, and the
   * advance is now its to make.
   *
   * `reconciled` means the agent had ALREADY applied this base itself and only host state moved —
   * distinct from `fast-forwarded`, where this call advanced the agent. Conflating them is what
   * made a sweep look broken next to a single sync: the sweep defers, the agent applies seconds
   * later off its footer notice, and the next sync claims credit for an advance nobody made here.
   */
  outcome:
    'forced' | 'up-to-date' | 'rebased' | 'fast-forwarded' | 'reconciled' | 'delivered' | 'skipped'
  syncRef: string
  /** The new seed commit after syncing (absent when skipped). */
  newSeed?: string
  /** What `quimby/base` points at (present for the 'delivered' outcome). */
  baseCommit?: string
  /** Why the advance was left to the agent (present for the 'delivered' outcome). */
  deferred?: SyncDeferReason
  /** Commits rebased onto the new base (present for the 'rebased' outcome). */
  commitsReplayed?: number
  /** The failure message when the outcome is 'skipped' (only reachable under `all`). */
  error?: string
}

/**
 * Sync one or more agents onto their base, classifying each outcome. Owns the command's
 * validation (name-or-`all`, the `base`/`current` exclusivity, detached-HEAD under
 * `current`) and the `current` → host-branch resolution, so the CLI only forwards flags.
 *
 * Under `all`, an agent whose sync conflicts is recorded as `skipped` and the sweep
 * continues; for an explicit name set, the conflict throws. Progress is narrated through
 * `reporter`; the returned outcomes carry the same information for assertions.
 */
export async function syncAgents(
  opts: Readonly<SyncAgentsOptions>,
  reporter: Reporter = silentReporter,
): Promise<SyncAgentOutcome[]> {
  const { state, repoRoot } = opts

  if (!opts.all && opts.names.length === 0) {
    throw new QuimbyError('Specify one or more agent names, or use --all')
  }
  if (opts.base && opts.current) {
    throw new QuimbyError('Use --base <ref> or --current, not both')
  }
  if (opts.all && opts.base) {
    throw new QuimbyError('--base retargets a single agent; use it with a name, not --all')
  }
  // Both advance the agent from the host, but they differ on what happens to its work — so picking
  // one has to be explicit rather than resolved by precedence.
  if (opts.force && opts.apply) {
    throw new QuimbyError(
      "Use -f or --apply, not both: -f discards the agent's work, --apply rebases and keeps it.",
    )
  }

  // --current is sugar for `--base <the host's current branch>`, resolved once. Unlike an
  // arbitrary --base it reads as "snap onto where I am", so it is allowed with --all.
  let base = opts.base
  if (opts.current) {
    const branch = await git.getCurrentBranch(repoRoot)
    if (!branch) {
      throw new QuimbyError(
        'Cannot use --current: HEAD is detached (no branch to track). Pass --base <ref> instead.',
      )
    }
    base = branch
  }

  const names = opts.all ? Object.keys(state.agents) : [...opts.names]
  if (names.length === 0) {
    reporter.info('No agents to sync.')
    return []
  }

  const outcomes: SyncAgentOutcome[] = []
  // One project push per remote destination for the whole sweep. Every SSH agent on a host shares
  // one remote project root, so without this a sweep rsyncs the identical tree once per agent —
  // multiplying both the wall time and the chance that one transient ssh/rsync failure turns an
  // agent into a `skipped` that syncs fine on its own a moment later.
  const syncedProjects = new Set<string>()
  for (const name of names) {
    const agent = state.agents[name]
    if (!agent) {
      throw new QuimbyError(`Agent "${name}" not found`)
    }
    const prevSeed = agent.seedCommit
    const syncRef = agent.syncRef ?? state.sourceRef

    try {
      const result = await syncAgent(repoRoot, name, {
        force: opts.force,
        apply: opts.apply,
        base,
        syncedProjects,
      })
      const seedShort = result.newSeed.slice(0, 8)
      // The graph edit reached the agent — say so, since it takes effect on the next dispatch
      // and is otherwise invisible next to the seed advance.
      if (result.edgesUpdated)
        reporter.info(`${name}: settings refreshed from config (role / edges / nudge)`)
      if (opts.force) {
        reporter.success(`${name}: hard-reset to ${syncRef} (${seedShort})`)
        outcomes.push({ name, outcome: 'forced', syncRef, newSeed: result.newSeed })
      } else if (!result.applied) {
        // Deferred: the base is on the agent as `quimby/base`, its history is untouched. This MUST
        // NOT fall through to the `newSeed === prevSeed` branch below, which would report "already
        // up to date" — the seed genuinely did not move, so the check is true and the sentence is a
        // lie. An advance the agent still has to make has to say so.
        reporter.info(
          `${name}: base delivered (${result.baseCommit.slice(0, 8)}) — not applied, the agent has ` +
            `${result.deferred === 'commits' ? `${result.commitsReplayed} commit(s) to rebase` : 'uncommitted work'}. ` +
            `It applies this itself; "quimby sync ${name} --apply" rebases it from here (keeps its ` +
            `work), "-f" hard-resets (discards it).`,
        )
        outcomes.push({
          name,
          outcome: 'delivered',
          syncRef,
          newSeed: result.newSeed,
          baseCommit: result.baseCommit,
          deferred: result.deferred,
          commitsReplayed: result.commitsReplayed,
        })
      } else if (result.reconciled) {
        reporter.success(
          `${name}: already on ${syncRef} (${seedShort}) — the agent applied the base itself; ` +
            'host state caught up',
        )
        outcomes.push({ name, outcome: 'reconciled', syncRef, newSeed: result.newSeed })
      } else if (result.newSeed === prevSeed) {
        reporter.info(`${name}: already up to date with ${syncRef}`)
        outcomes.push({ name, outcome: 'up-to-date', syncRef, newSeed: result.newSeed })
      } else if (result.rebased) {
        reporter.success(
          `${name}: ${result.commitsReplayed} commit(s) rebased onto ${syncRef} (${seedShort})`,
        )
        outcomes.push({
          name,
          outcome: 'rebased',
          syncRef,
          newSeed: result.newSeed,
          commitsReplayed: result.commitsReplayed,
        })
      } else {
        reporter.success(`${name}: fast-forwarded to ${syncRef} (${seedShort})`)
        outcomes.push({ name, outcome: 'fast-forwarded', syncRef, newSeed: result.newSeed })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Under --all a conflicted agent is skipped, not fatal — sync the rest.
      if (opts.all) {
        reporter.warn(`${name}: skipped — ${message}`)
        outcomes.push({ name, outcome: 'skipped', syncRef, error: message })
        continue
      }
      throw err
    }
  }

  return outcomes
}
