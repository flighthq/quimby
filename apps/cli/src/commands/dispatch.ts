import { rebaseAgentOntoBase } from '@quimbyhq/agent'
import { dispatchOutboxes, passiveDeliveryNotice } from '@quimbyhq/handoff'
import { nudgeAgentSession } from '@quimbyhq/session'
import { logger } from '@quimbyhq/utils'
import {
  loadQuimbyConfig,
  resolveFocusPolicy,
  resolveNudgePolicy,
  resolveWorkspace,
} from '@quimbyhq/workspace'
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
  const config = await loadQuimbyConfig(repoRoot)

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
      defaultNudge: resolveNudgePolicy(config),
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
        if (result.skippedFiles?.length) {
          logger.warn(
            `  NOT carried: ${result.skippedFiles.join(', ')} — a parcel cannot hold a file with ` +
              'that name (or a directory). Rename the attachment and re-send.',
          )
        }
        // §6a: only a directed / escalation / reply parcel interrupts the recipient. An advisory
        // parcel lands passively in the inbox (read on the recipient's own turn), so no nudge.
        if (!result.interrupts) {
          // Say why nothing woke. A downgraded escalation is a config gap worth a warning; an
          // ordinary advisory is by design, so it reports at info.
          const notice = passiveDeliveryNotice(sender, result)
          if (result.downgraded) logger.warn(notice)
          else logger.info(notice)
        }
        if (args.nudge && result.interrupts && result.parcelName) {
          const recip = state.agents[result.recipient]
          if (recip) {
            const kind = result.escalation
              ? 'escalation'
              : result.userDirected
                ? 'delegated task'
                : 'parcel'
            await nudgeAgentSession({
              agent: recip,
              displayName: result.recipient,
              courier: `${kind} ${result.parcelName} from ${sender}`,
              whenFocused: resolveFocusPolicy(config, recip),
              reporter: consolaReporter,
            })
          }
        }
      } else if (result.status === 'busy') {
        logger.info(
          `Skipping "${result.recipient}" — another dispatch is carrying it (left queued)`,
        )
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
