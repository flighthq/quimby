import { assignAgentTask } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { dashboardSessionName } from '@quimbyhq/paths'
import { hasAgentSession, nudgeAgentSession } from '@quimbyhq/session'
import { renderVerifyRequest } from '@quimbyhq/template'
import type { AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { consolaReporter } from '../reporter'

// Sent when no message is given: the lightest possible kick — tell the agent to
// pick back up. Agent-agnostic and harmless to a paused or idle session.
const DEFAULT_NUDGE = 'continue'

export default defineCommand({
  meta: {
    name: 'nudge',
    description: 'Wake an agent, or set its durable assignment with -m',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent to nudge (omit when using --all)',
      required: false,
    },
    message: {
      type: 'string',
      alias: 'm',
      description:
        'Durable assignment text (or @file); use --raw to type ephemeral session text instead',
    },
    raw: {
      type: 'boolean',
      description: 'Type -m verbatim into the live session instead of changing the assignment',
      default: false,
    },
    clear: {
      type: 'boolean',
      alias: 'c',
      description: "Type '/clear' first to reset the agent's context, then send the nudge",
      default: false,
    },
    all: {
      type: 'boolean',
      description: 'Broadcast to every agent with a live tmux session (probed)',
      default: false,
    },
    verify: {
      type: 'boolean',
      description:
        'Type a canned self-verification request (the agent runs its `check` and records a quimby-attest block)',
      default: false,
    },
  },
  run: runNudgeCommand,
})

export async function runNudgeCommand({
  args,
}: {
  args: {
    agent?: string
    message?: string
    raw: boolean
    clear: boolean
    all: boolean
    verify?: boolean
  }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  if (args.raw && args.message === undefined) {
    throw new QuimbyError('The --raw option requires a message with -m.')
  }
  if (args.raw && args.verify) {
    throw new QuimbyError('Use either --raw -m or --verify, not both.')
  }
  if (args.all && args.message !== undefined && !args.raw) {
    throw new QuimbyError(
      'Refusing to replace every agent assignment through nudge --all -m; assign agents individually, or add --raw for an intentional session broadcast.',
    )
  }

  // A task-bearing nudge is an ergonomic alias for assign: persist the user's intent
  // before waking the agent so a clear/relaunch cannot revive a stale assignment.
  if (args.message !== undefined && !args.raw) {
    if (!args.agent) {
      throw new QuimbyError('Provide an agent name for a durable assignment.')
    }
    const agent = state.agents[args.agent]
    if (!agent) {
      throw new QuimbyError(`Agent "${args.agent}" not found`)
    }
    const result = await assignAgentTask(
      {
        state,
        repoRoot,
        name: args.agent,
        message: args.message,
        sync: true,
        nudge: true,
        verify: args.verify ?? agent.verifyByDefault ?? false,
      },
      consolaReporter,
    )
    if (result.nudgeText !== null) {
      await nudgeAgentSession({
        agent,
        clear: args.clear,
        displayName: args.agent,
        courier: 'assignment updated',
        reporter: consolaReporter,
      })
    }
    return
  }

  // `--verify` types the canned self-verify request (named to the agent's own `check`);
  // an explicit `--raw -m` is the only arbitrary text passed through verbatim.
  const textFor = (agent: Readonly<AgentState>): string =>
    args.verify ? renderVerifyRequest(agent.check) : (args.message ?? DEFAULT_NUDGE)
  const dashSession = dashboardSessionName(state.id)

  if (args.all) {
    // Probe tmux for which sessions are actually live, so we target exactly the
    // agents that will receive it — not every session-capable agent, most of which
    // may not be running.
    const capable = Object.entries(state.agents).filter(
      ([, agent]) => isSSH(agent.location) || agent.tmux,
    )
    const probed = await Promise.all(
      capable.map(
        async ([name, agent]) =>
          [name, agent, await hasAgentSession(agent, { dashboardSession: dashSession })] as const,
      ),
    )
    const live = probed.filter(([, , isLive]) => isLive)
    if (live.length === 0) {
      logger.info('No running agent sessions to nudge.')
      return
    }

    logger.start(`Nudging ${live.length} agent(s): ${live.map(([name]) => name).join(', ')}`)
    for (const [name, agent] of live) {
      await nudgeAgentSession({
        agent,
        clear: args.clear,
        displayName: name,
        text: textFor(agent),
        dashboardSession: dashSession,
        reporter: consolaReporter,
      })
    }
    return
  }

  if (!args.agent) {
    throw new QuimbyError('Provide an agent name, or --all to broadcast to every tmux/SSH agent.')
  }

  const agent = state.agents[args.agent]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }

  await nudgeAgentSession({
    agent,
    clear: args.clear,
    displayName: args.agent,
    text: textFor(agent),
    dashboardSession: dashSession,
    reporter: consolaReporter,
  })
}
