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
    'skip-guard': {
      type: 'boolean',
      description: "Skip each source agent's guard command",
      default: false,
    },
    // citty maps `--no-verify` onto this `verify` flag (its built-in `--no-`
    // negation) — a literal `no-verify` arg would never flip, so the alias
    // lives here as the git-muscle-memory way to skip the guard.
    verify: {
      type: 'boolean',
      description: 'Run each guard before packaging (--no-verify or --skip-guard to skip)',
      default: true,
    },
  },
  run: runDispatchCommand,
})

export async function runDispatchCommand({
  args,
}: {
  args: { agent: string; rebase: boolean; 'skip-guard': boolean; verify: boolean }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.agents[args.agent]) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }
  const skipGuard = args['skip-guard'] || !args.verify

  const recipients = await readOutboxRecipients(repoRoot, args.agent)
  if (recipients.length === 0) {
    logger.info(`Agent "${args.agent}" has no queued parcels.`)
    return
  }

  for (const recipient of recipients) {
    if (!state.agents[recipient]) {
      logger.warn(`Skipping "${recipient}" — no such agent (left in outbox to fix)`)
      continue
    }
    try {
      const draft = await readOutboxDraft(repoRoot, args.agent, recipient)
      const meta = await stageParcel({
        state,
        repoRoot,
        from: args.agent,
        to: recipient,
        note: draft.note || undefined,
        attach: draft.attach,
        skipGuard,
        rebase: args.rebase,
      })
      await deliverHandoff({
        repoRoot,
        name: meta.name,
        to: recipient,
        toLocation: state.agents[recipient].location,
        projectId: state.id,
      })
      await discardHandoff(repoRoot, meta.name)
      await markHandoffSent(repoRoot, args.agent, recipient)
      logger.success(`Delivered to "${recipient}"`)
    } catch (err) {
      logger.warn(
        `Failed to deliver to "${recipient}" (left in outbox): ${err instanceof Error ? err.message : err}`,
      )
    }
  }
}
