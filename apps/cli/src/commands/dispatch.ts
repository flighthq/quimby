import { QuimbyError } from '@quimbyhq/errors'
import {
  deliverHandoff,
  discardHandoff,
  markHandoffSent,
  readOutboxDraft,
  readOutboxRecipients,
} from '@quimbyhq/handoff'
import type { QuimbyState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { stageParcel } from '../courier'
import { nudgeAgentSession } from '../nudge'

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
    totalQueued += await dispatchOutbox(state, repoRoot, sender, {
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

/**
 * Carry one agent's queued outbox parcels to their recipients. Returns the number of
 * recipients it attempted (0 = the outbox was empty), so the caller can report when a
 * whole `--all` pass found nothing. Empty outboxes are silent — a `--all` over many
 * agents shouldn't print a line for each one that had nothing queued.
 */
async function dispatchOutbox(
  state: Readonly<QuimbyState>,
  repoRoot: string,
  sender: string,
  opts: { rebase: boolean; nudge: boolean },
): Promise<number> {
  const senderId = state.agents[sender].id
  const recipients = await readOutboxRecipients(repoRoot, senderId)
  if (recipients.length === 0) return 0

  logger.start(`Dispatching "${sender}" → ${recipients.length} recipient(s)…`)
  for (const recipient of recipients) {
    const recip = state.agents[recipient]
    if (!recip) {
      logger.warn(`Skipping "${recipient}" — no such agent (left in outbox to fix)`)
      continue
    }
    try {
      const draft = await readOutboxDraft(repoRoot, senderId, recipient)
      const meta = await stageParcel({
        state,
        repoRoot,
        from: sender,
        to: recipient,
        note: draft.note || undefined,
        attach: draft.attach,
        rebase: opts.rebase,
      })
      await deliverHandoff({
        repoRoot,
        name: meta.name,
        to: recipient,
        toId: recip.id,
        toLocation: recip.location,
        projectId: state.id,
      })
      await discardHandoff(repoRoot, meta.name)
      await markHandoffSent(repoRoot, senderId, recipient)
      logger.success(`Delivered "${sender}" → "${recipient}"`)

      if (opts.nudge) {
        // Point the recipient at the parcel just dropped in its inbox (the inbox sits
        // in the agent's cwd, named by sender + content hash).
        await nudgeAgentSession({
          agent: recip,
          displayName: recipient,
          text: `New handoff in your inbox: @inbox/${meta.name}/ — please review.`,
        })
      }
    } catch (err) {
      logger.warn(
        `Failed to deliver to "${recipient}" (left in outbox): ${err instanceof Error ? err.message : err}`,
      )
    }
  }
  return recipients.length
}
