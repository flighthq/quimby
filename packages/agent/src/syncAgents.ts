import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'

import { syncAgent } from './sync'

export interface SyncAgentsOptions {
  state: Readonly<QuimbyState>
  repoRoot: string
  names: readonly string[]
  all: boolean
  force: boolean
  base?: string
  current: boolean
}

export interface SyncAgentOutcome {
  name: string
  outcome: 'forced' | 'up-to-date' | 'rebased' | 'fast-forwarded' | 'skipped'
  syncRef: string
  /** The new seed commit after syncing (absent when skipped). */
  newSeed?: string
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
  for (const name of names) {
    const agent = state.agents[name]
    if (!agent) {
      throw new QuimbyError(`Agent "${name}" not found`)
    }
    const prevSeed = agent.seedCommit
    const syncRef = agent.syncRef ?? state.sourceRef

    try {
      const result = await syncAgent(repoRoot, name, { force: opts.force, base })
      const seedShort = result.newSeed.slice(0, 8)
      if (opts.force) {
        reporter.success(`${name}: hard-reset to ${syncRef} (${seedShort})`)
        outcomes.push({ name, outcome: 'forced', syncRef, newSeed: result.newSeed })
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
