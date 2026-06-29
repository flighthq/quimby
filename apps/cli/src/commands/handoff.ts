import { QuimbyError } from '@quimbyhq/errors'
import { assembleHostHandoff, deliverHandoff, discardHandoff, HOST_SENDER } from '@quimbyhq/handoff'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { stageParcel } from '../courier'

export default defineCommand({
  meta: {
    name: 'handoff',
    description: "Carry an agent's work to another agent, or your host's work to an agent",
  },
  args: {
    from: {
      type: 'positional',
      description: 'Source agent — or, used alone, the recipient (host → it)',
      required: true,
    },
    to: {
      type: 'positional',
      description: 'Recipient agent (when a source agent is given)',
      required: false,
    },
    message: {
      type: 'string',
      alias: 'm',
      description: "The parcel's note",
    },
    attach: {
      type: 'string',
      description: "Carry a different agent's diff than the source",
    },
    rebase: {
      type: 'boolean',
      description: 'Rebase the code source onto host HEAD before packaging',
      default: false,
    },
  },
  run: runHandoffCommand,
})

export async function runHandoffCommand({
  args,
}: {
  args: {
    from: string
    to?: string
    message?: string
    attach?: string
    rebase: boolean
  }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  // The recipient is the last positional; a leading positional overrides the
  // default source (the host). So `handoff B` is host → B and `handoff A B` is A → B.
  const recipient = args.to ?? args.from
  const fromHost = args.to === undefined

  const recip = state.agents[recipient]
  if (!recip) {
    throw new QuimbyError(`Agent "${recipient}" not found`)
  }

  if (fromHost) {
    const meta = await assembleHostHandoff({
      repoRoot,
      to: recipient,
      base: recip.seedCommit,
      note: args.message,
    })
    await deliverHandoff({
      repoRoot,
      name: meta.name,
      to: recipient,
      toLocation: recip.location,
      projectId: state.id,
    })
    await discardHandoff(repoRoot, meta.name)
    logger.success(`Handed off from ${HOST_SENDER} to "${recipient}"`)
    return
  }

  const source = args.from
  if (!state.agents[source]) {
    throw new QuimbyError(`Agent "${source}" not found`)
  }

  const meta = await stageParcel({
    state,
    repoRoot,
    from: source,
    to: recipient,
    note: args.message,
    attach: args.attach,
    rebase: args.rebase,
  })
  await deliverHandoff({
    repoRoot,
    name: meta.name,
    to: recipient,
    toLocation: recip.location,
    projectId: state.id,
  })
  await discardHandoff(repoRoot, meta.name)
  logger.success(`Handed off from "${source}" to "${recipient}"`)
}
