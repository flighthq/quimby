import { confirm, isCancel } from '@clack/prompts'
import { hasAgentSession, nudgeAgentSession } from '@quimbyhq/session'
import { remoteTrackingRef, renderResolveConflictRequest } from '@quimbyhq/template'
import type { AgentState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'

import { consolaReporter } from './reporter'

export interface ConflictNudgeOptions {
  agent: Readonly<AgentState>
  displayName: string
  /** The ref the agent must rebase onto — what the courier message names. */
  syncRef: string
  /**
   * What to do with no TTY to ask. `print` (sync's rule) only shows the command: a conflicted
   * agent should not be woken behind the user's back, mirroring `assign`'s refusal to nudge onto a
   * broken baseline. `nudge` (merge's rule) fires it, since `merge` has always auto-nudged and a
   * script that merges expects the agent to be told.
   */
  whenNonInteractive: 'nudge' | 'print'
}

/**
 * Offer to wake a conflicted agent with the "rebase and resolve" courier request, so a failed sync
 * or merge ends with the agent actually told what to do rather than the user guessing.
 *
 * The nudge is **forced**: this is the direct product of a command the user just ran, and the whole
 * point is to hand over resolution instructions — the §7 focus hold exists to protect keystrokes
 * from *background* couriers, not to swallow the answer to a question you just asked. Before the
 * hold became focus-aware this was exactly the message that vanished into "Held nudge for …".
 *
 * A stopped agent has no session to type into, so it reports how to start one instead.
 */
export async function offerConflictNudge(opts: Readonly<ConflictNudgeOptions>): Promise<boolean> {
  const { agent, displayName, syncRef } = opts

  if (!(await hasAgentSession(agent))) {
    logger.info(
      `"${displayName}" isn't running — start it with \`quimby start ${displayName}\`, ` +
        `then have it rebase onto ${remoteTrackingRef(syncRef)}.`,
    )
    return false
  }

  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY)
  if (!interactive) {
    if (opts.whenNonInteractive === 'print') {
      logger.info(conflictNudgeCommand(displayName, syncRef))
      return false
    }
  } else {
    const answer = await confirm({
      message: `Nudge "${displayName}" to rebase onto ${remoteTrackingRef(syncRef)} and resolve?`,
      initialValue: true,
    })
    if (isCancel(answer) || !answer) {
      logger.info(conflictNudgeCommand(displayName, syncRef))
      return false
    }
  }

  await nudgeAgentSession({
    agent,
    displayName,
    courier: renderResolveConflictRequest(syncRef),
    force: true,
    reporter: consolaReporter,
  })
  return true
}

/** The ready-to-paste equivalent, shown whenever the offer is declined or cannot be made. */
export function conflictNudgeCommand(displayName: string, syncRef: string): string {
  return `To ask it yourself: quimby nudge ${displayName} -m "${renderResolveConflictRequest(syncRef)}"`
}
