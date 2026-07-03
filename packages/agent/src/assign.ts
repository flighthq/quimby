import { QuimbyError } from '@quimbyhq/errors'
import { getAgentDir, remoteAgentDir } from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { getSSHTransport } from '@quimbyhq/transport'
import type { QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { readText, writeText } from '@quimbyhq/utils'
import { join } from 'pathe'

import { getAgentSyncStatus, syncAgent } from './sync'

export interface AssignAgentTaskOptions {
  state: Readonly<QuimbyState>
  repoRoot: string
  name: string
  /** The task text, or `@path` to read the task from a file (relative to cwd). */
  message?: string
  /** Sync the agent to its base before assigning (the durable message is written first). */
  sync: boolean
  /**
   * When set, retarget the agent's `syncRef` to this ref and sync onto it (even at 0 behind),
   * instead of syncing against the current base. Ignored when `sync` is false.
   */
  syncRef?: string
  /** Whether a nudge was requested; the returned `nudgeText` honors the stale-agent rule. */
  nudge: boolean
}

export interface AssignAgentTaskResult {
  /** How many commits behind its base the agent was (0 when up to date or sync skipped). */
  behind: number
  /** True when the pre-assign sync failed (rebase conflict) — the assignment is still written. */
  syncFailed: boolean
  /**
   * The text to type into the agent's session, or `null` when no nudge should fire.
   * Null whenever nudging was not requested, or the sync failed (never wake a stale
   * agent) — this is the invariant the CLI relies on rather than re-deriving.
   */
  nudgeText: string | null
}

/**
 * Set an agent's standing task: write `assignment.md` first (so the user's intent is
 * durable even if the sync fails), then optionally sync the agent onto its base.
 *
 * The assignment is always written; the nudge is suppressed on sync failure so a stale
 * agent is never woken. Progress is narrated through `reporter`; the returned result
 * carries the control-flow decisions (whether to nudge, whether the sync failed).
 */
export async function assignAgentTask(
  opts: Readonly<AssignAgentTaskOptions>,
  reporter: Reporter = silentReporter,
): Promise<AssignAgentTaskResult> {
  const { state, repoRoot, name } = opts

  const agent = state.agents[name]
  if (!agent) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }

  let taskContent = opts.message ?? ''
  if (taskContent.startsWith('@')) {
    taskContent = await readText(taskContent.slice(1))
  }
  if (!taskContent) {
    throw new QuimbyError('Provide a message with -m (use `quimby handoff` to deliver work)')
  }

  if (isSSH(agent.location)) {
    const transport = getSSHTransport(agent.location)
    const rAgentDir = remoteAgentDir(state.id, agent.id, agent.location.base)
    await transport.writeFile(`${rAgentDir}/assignment.md`, taskContent)
  } else {
    const agentDir = getAgentDir(repoRoot, agent.id)
    await writeText(join(agentDir, 'assignment.md'), taskContent)
  }

  reporter.success(`Assignment set for "${name}"`)

  let behind = 0
  let syncFailed = false
  if (opts.sync) {
    const retargetRef = opts.syncRef && opts.syncRef !== '' ? opts.syncRef : undefined
    const status = await getAgentSyncStatus(repoRoot, agent, state.sourceRef)
    behind = status.behind
    // Sync when the agent trails its base, or whenever a retarget was requested — the new ref
    // can differ from the current base even at 0 behind, so `--sync <ref>` always moves it.
    if (retargetRef || behind > 0) {
      reporter.start(
        retargetRef
          ? `Retargeting "${name}" to ${retargetRef} and syncing`
          : `"${name}" is ${behind} commit(s) behind ${status.syncRef} — syncing`,
      )
      try {
        const result = await syncAgent(
          repoRoot,
          name,
          retargetRef ? { base: retargetRef } : undefined,
        )
        if (result.rebased) {
          reporter.success(
            `Rebased ${result.commitsReplayed} commit(s) onto ${result.newSeed.slice(0, 8)}`,
          )
        } else {
          reporter.success(`Synced to ${result.newSeed.slice(0, 8)}`)
        }
      } catch (err) {
        syncFailed = true
        const message = err instanceof Error ? err.message : String(err)
        reporter.warn(`Sync failed — ${message}`)
        reporter.warn('Assignment written, but the agent is stale. Resolve and run `quimby sync`.')
      }
    }
  }

  return {
    behind,
    syncFailed,
    nudgeText: opts.nudge && !syncFailed ? ASSIGNMENT_NUDGE_TEXT : null,
  }
}

const ASSIGNMENT_NUDGE_TEXT = "Here's your assignment: @assignment.md"
