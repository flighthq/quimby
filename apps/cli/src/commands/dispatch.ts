import { rebaseAgentOntoBase } from '@quimbyhq/agent'
import { dispatchOutboxes } from '@quimbyhq/handoff'
import { nudgeAgentSession } from '@quimbyhq/session'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { attestationResolver } from '../attestation'
import { consolaReporter } from '../reporter'

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

  const { senders, totalQueued } = await dispatchOutboxes(
    {
      state,
      repoRoot,
      agent: args.agent,
      all: args.all,
      beforeStage: args.rebase
        ? (name) => rebaseAgentOntoBase(repoRoot, name, consolaReporter).then(() => undefined)
        : undefined,
      resolveAttestation: attestationResolver(repoRoot, state),
    },
    consolaReporter,
  )

  for (const { sender, results } of senders) {
    for (const result of results) {
      if (result.status === 'delivered') {
        const fileSuffix = result.files?.length
          ? ` (+${result.files.length} file(s): ${result.files.join(', ')})`
          : ''
        logger.success(`Delivered "${sender}" → "${result.recipient}"${fileSuffix}`)
        if (args.nudge && result.parcelName) {
          const recip = state.agents[result.recipient]
          if (recip) {
            await nudgeAgentSession({
              agent: recip,
              displayName: result.recipient,
              courier: `parcel ${result.parcelName} from ${sender}`,
              reporter: consolaReporter,
            })
          }
        }
      } else if (result.status === 'unknown') {
        logger.warn(`Skipping "${result.recipient}" — no such agent (left queued to fix)`)
      } else {
        logger.warn(`Failed to deliver to "${result.recipient}" (left queued): ${result.error}`)
      }
    }
  }

  if (totalQueued === 0) {
    logger.info(
      args.all
        ? 'No queued parcels in any outbox.'
        : `Agent "${args.agent}" has no queued parcels.`,
    )
  }
}
