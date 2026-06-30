import { QuimbyError } from '@quimbyhq/errors'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { hasAgentSession, nudgeAgentSession } from '../nudge'

// Sent when no message is given: the lightest possible kick — tell the agent to
// pick back up. Agent-agnostic and harmless to a paused or idle session.
const DEFAULT_NUDGE = 'continue'

export default defineCommand({
  meta: {
    name: 'nudge',
    description: 'Wake a running agent by typing a message into its tmux session',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Agent to nudge (omit when using --all)',
      required: false,
    },
    message: {
      type: 'string',
      alias: 'm',
      description:
        'Text to type into the agent (defaults to "continue"); also carries CLI control commands like "/clear" or "/model …"',
    },
    all: {
      type: 'boolean',
      description: 'Broadcast to every agent with a live tmux session (probed)',
      default: false,
    },
  },
  run: runNudgeCommand,
})

export async function runNudgeCommand({
  args,
}: {
  args: { name?: string; message?: string; all: boolean }
}) {
  const { state } = await resolveWorkspace()

  // Sent verbatim — an `@path` in the message is Claude's file-reference syntax to
  // pass through, not a file to read (unlike `assign`, whose @file reads task content).
  const text = args.message ?? DEFAULT_NUDGE

  if (args.all) {
    // Probe tmux for which sessions are actually live, so we target exactly the
    // agents that will receive it — not every session-capable agent, most of which
    // may not be running.
    const capable = Object.entries(state.agents).filter(
      ([, agent]) => isSSH(agent.location) || agent.tmux,
    )
    const probed = await Promise.all(
      capable.map(async ([name, agent]) => [name, agent, await hasAgentSession(agent)] as const),
    )
    const live = probed.filter(([, , isLive]) => isLive)
    if (live.length === 0) {
      logger.info('No running agent sessions to nudge.')
      return
    }

    logger.start(`Nudging ${live.length} agent(s): ${live.map(([name]) => name).join(', ')}`)
    for (const [name, agent] of live) {
      await nudgeAgentSession({ agent, displayName: name, text })
    }
    return
  }

  if (!args.name) {
    throw new QuimbyError('Provide an agent name, or --all to broadcast to every tmux/SSH agent.')
  }

  const agent = state.agents[args.name]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
  }

  await nudgeAgentSession({
    agent,
    displayName: args.name,
    text,
  })
}
