import { QuimbyError } from '@quimbyhq/errors'
import {
  deliverHandoff,
  discardHandoff,
  markHandoffSent,
  readOutboxDraft,
  readOutboxRecipients,
} from '@quimbyhq/handoff'
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
      description: 'Agent whose outbox to dispatch',
      required: true,
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
  args: { agent: string; rebase: boolean; nudge: boolean }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.agents[args.agent]) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }

  const senderId = state.agents[args.agent].id
  const recipients = await readOutboxRecipients(repoRoot, senderId)
  if (recipients.length === 0) {
    logger.info(`Agent "${args.agent}" has no queued parcels.`)
    return
  }

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
        from: args.agent,
        to: recipient,
        note: draft.note || undefined,
        attach: draft.attach,
        rebase: args.rebase,
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
      logger.success(`Delivered to "${recipient}"`)

      if (args.nudge) {
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
}
