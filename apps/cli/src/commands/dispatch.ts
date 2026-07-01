import { syncAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { dispatchOutbox } from '@quimbyhq/handoff'
import { nudgeAgentSession } from '@quimbyhq/session'
import type { QuimbyState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'dispatch',
    description: "Deliver an agent's queued outbox parcels to their recipients",
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent whose outbox to dispatch (omit with --all)',
      required: false,
    },
    all: {
      type: 'boolean',
      description: 'Dispatch every agent’s outbox in one pass',
      default: false,
    },
    rebase: {
      type: 'boolean',
      description: 'Rebase each code source onto host HEAD before packaging',
      default: false,
    },
    nudge: {
      type: 'boolean',
      description:
        'Wake each running recipient by injecting an inbox notice + Return into its tmux session (on by default; --no-nudge to skip)',
      default: true,
    },
  },
  run: runDispatchCommand,
})

export async function runDispatchCommand({
  args,
}: {
  args: { agent?: string; all: boolean; rebase: boolean; nudge: boolean }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!args.all && !args.agent) {
    throw new QuimbyError('Specify an agent, or --all to dispatch every outbox.')
  }
  if (!args.all && !state.agents[args.agent as string]) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }

  const senders = args.all ? Object.keys(state.agents) : [args.agent as string]

  let totalQueued = 0
  for (const sender of senders) {
    totalQueued += await dispatchSenderOutbox(state, repoRoot, sender, {
      rebase: args.rebase,
      nudge: args.nudge,
    })
  }

  if (totalQueued === 0) {
    logger.info(
      args.all
        ? 'No queued parcels in any outbox.'
        : `Agent "${args.agent}" has no queued parcels.`,
    )
  }
}

async function dispatchSenderOutbox(
  state: Readonly<QuimbyState>,
  repoRoot: string,
  sender: string,
  opts: { rebase: boolean; nudge: boolean },
): Promise<number> {
  const beforeStage = opts.rebase
    ? (codeSourceName: string) => rebaseOntoHead(repoRoot, codeSourceName)
    : undefined

  const results = await dispatchOutbox({ state, repoRoot, sender, beforeStage })
  if (results.length === 0) return 0

  logger.start(`Dispatching "${sender}" → ${results.length} recipient(s)…`)
  for (const result of results) {
    if (result.status === 'delivered') {
      logger.success(`Delivered "${sender}" → "${result.recipient}"`)
      if (opts.nudge) {
        const recip = state.agents[result.recipient]
        if (recip) {
          await nudgeAgentSession({
            agent: recip,
            displayName: result.recipient,
            text: `New handoff in your inbox: @inbox/${result.parcelName}/ — please review.`,
          })
        }
      }
    } else if (result.status === 'unknown') {
      logger.warn(`Skipping "${result.recipient}" — no such agent (left in outbox to fix)`)
    } else {
      logger.warn(`Failed to deliver to "${result.recipient}" (left in outbox): ${result.error}`)
    }
  }
  return results.length
}

async function rebaseOntoHead(repoRoot: string, agentName: string): Promise<void> {
  logger.start(`Syncing "${agentName}" onto its base`)
  const result = await syncAgent(repoRoot, agentName)
  if (result.rebased) {
    logger.success(`Rebased ${result.commitsReplayed} commit(s) onto ${result.newSeed.slice(0, 8)}`)
  } else {
    logger.info(`Already based on host HEAD (${result.newSeed.slice(0, 8)})`)
  }
}
