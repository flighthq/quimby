import { confirm, isCancel } from '@clack/prompts'
import { hasAgentSession, nudgeAgentSession } from '@quimbyhq/session'
import {
  remoteTrackingRef,
  renderApplyBaseRequest,
  renderResolveConflictRequest,
} from '@quimbyhq/template'
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
  return offerNudge({
    agent,
    displayName,
    question: `Nudge "${displayName}" to rebase onto ${remoteTrackingRef(syncRef)} and resolve?`,
    courier: renderResolveConflictRequest(syncRef),
    fallback: conflictNudgeCommand(displayName, syncRef),
    notRunning:
      `"${displayName}" isn't running — start it with \`quimby start ${displayName}\`, ` +
      `then have it rebase onto ${remoteTrackingRef(syncRef)}.`,
    whenNonInteractive: opts.whenNonInteractive,
  })
}

/**
 * Offer to wake an agent whose base was DELIVERED but not applied — the deferral case, where the
 * agent has commits or a dirty tree and quimby deliberately left its history alone.
 *
 * This exists because the deliver-vs-apply split made the conflict offer unreachable for the common
 * case: a routine sync no longer attempts the rebase, so it can no longer fail, so the "rebase and
 * resolve" prompt never appears. Without this, `quimby sync <agent>` on a busy agent ends with the
 * base delivered and nothing able to tell the agent to take it — it finds out on its next `agent.sh`
 * invocation, which for an idle agent may be a long time and for a stopped one is never.
 *
 * Same contract as the conflict offer, for the same reason: it is the direct product of a command
 * the user just ran, so it is forced past the focus hold, and `sync` only ever PRINTS when there is
 * no TTY — waking an agent is the user's call.
 */
export async function offerApplyBaseNudge(
  opts: Readonly<Omit<ConflictNudgeOptions, 'syncRef'> & { behind?: number }>,
): Promise<boolean> {
  const { agent, displayName } = opts
  const behind = opts.behind === undefined ? '' : ` (${opts.behind} commit(s) behind)`
  return offerNudge({
    agent,
    displayName,
    question: `Nudge "${displayName}" to apply the delivered base${behind}?`,
    courier: renderApplyBaseRequest(),
    fallback: applyBaseNudgeCommand(displayName),
    notRunning:
      `"${displayName}" isn't running — it applies the base itself on its next run ` +
      `(\`./agent.sh rebase\`), or \`quimby sync ${displayName} -f\` forces it, discarding its work.`,
    whenNonInteractive: opts.whenNonInteractive,
  })
}

/**
 * The sweep counterpart: ONE offer covering every agent a multi-agent sync deferred.
 *
 * `sync --all` used to report the deferred count and point at `quimby sync <agent>`, on the
 * reasoning that a prompt per agent would be unbearable on a busy fleet. That reasoning is right
 * and the conclusion was wrong: it left the sweep unable to do the one thing that makes the
 * per-agent command work. Running `quimby sync --all` and then `quimby sync foreman` produces the
 * SAME deferral twice — the second only looks like it succeeded because it offers this nudge. So
 * the sweep reads as broken and the single sync as the fix, when the difference is entirely the
 * prompt.
 *
 * One prompt for the whole set keeps the original concern satisfied: a fleet of ten deferred agents
 * asks once, not ten times, and the names are listed so it is clear what is being woken.
 */
export async function offerApplyBaseNudgeAll(
  opts: Readonly<{
    agents: ReadonlyArray<{ agent: Readonly<AgentState>; displayName: string; behind?: number }>
    whenNonInteractive: 'nudge' | 'print'
  }>,
): Promise<number> {
  // Only agents with a live session can be typed into. A stopped one applies the base on its next
  // run, so it is reported rather than counted as something the prompt could act on.
  const live: { agent: Readonly<AgentState>; displayName: string; behind?: number }[] = []
  const stopped: string[] = []
  for (const entry of opts.agents) {
    if (await hasAgentSession(entry.agent)) live.push(entry)
    else stopped.push(entry.displayName)
  }
  if (stopped.length > 0) {
    logger.info(
      `${stopped.join(', ')} — not running; each applies the base itself on its next run ` +
        '(`./agent.sh rebase`).',
    )
  }
  if (live.length === 0) return 0

  const names = live.map((e) => e.displayName).join(', ')
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY)
  if (!interactive) {
    if (opts.whenNonInteractive === 'print') {
      logger.info(
        `To ask them yourself: ${live.map((e) => `quimby sync ${e.displayName}`).join('; ')}`,
      )
      return 0
    }
  } else {
    const answer = await confirm({
      message: `Nudge ${live.length} agent(s) to apply the delivered base? (${names})`,
      initialValue: true,
    })
    if (isCancel(answer) || !answer) {
      logger.info(
        `To ask them yourself: ${live.map((e) => `quimby sync ${e.displayName}`).join('; ')}`,
      )
      return 0
    }
  }

  for (const entry of live) {
    await nudgeAgentSession({
      agent: entry.agent,
      displayName: entry.displayName,
      courier: renderApplyBaseRequest(),
      force: true,
      reporter: consolaReporter,
    })
  }
  return live.length
}

/** The ready-to-paste equivalent for the deferral case. */
export function applyBaseNudgeCommand(displayName: string): string {
  return `To ask it yourself: quimby nudge ${displayName} --raw -m "${renderApplyBaseRequest()}"`
}

async function offerNudge(opts: {
  agent: Readonly<AgentState>
  displayName: string
  question: string
  courier: string
  fallback: string
  notRunning: string
  whenNonInteractive: 'nudge' | 'print'
}): Promise<boolean> {
  if (!(await hasAgentSession(opts.agent))) {
    logger.info(opts.notRunning)
    return false
  }

  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY)
  if (!interactive) {
    if (opts.whenNonInteractive === 'print') {
      logger.info(opts.fallback)
      return false
    }
  } else {
    const answer = await confirm({ message: opts.question, initialValue: true })
    if (isCancel(answer) || !answer) {
      logger.info(opts.fallback)
      return false
    }
  }

  await nudgeAgentSession({
    agent: opts.agent,
    displayName: opts.displayName,
    courier: opts.courier,
    force: true,
    reporter: consolaReporter,
  })
  return true
}

/** The ready-to-paste equivalent, shown whenever the offer is declined or cannot be made. */
export function conflictNudgeCommand(displayName: string, syncRef: string): string {
  return `To ask it yourself: quimby nudge ${displayName} -m "${renderResolveConflictRequest(syncRef)}"`
}
