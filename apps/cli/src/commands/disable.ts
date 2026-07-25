import { setAgentEnabled } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { getAgentSessionState } from '@quimbyhq/session'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { killAgentTmuxSession } from './stop'

export default defineCommand({
  meta: {
    name: 'disable',
    description:
      'Disable an agent: free its live session, keep its work on disk, drop it from layouts',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent name',
      required: true,
    },
  },
  run: runDisableCommand,
})

export async function runDisableCommand({ args }: { args: { agent: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.agent]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }

  // Disable = keep the work, drop the live-session footprint. Free the session (the binding fleet
  // constraint), then persist the flag so `run`/`up` skip it and layouts prune it.
  const sessionState = await getAgentSessionState(agent)
  if (sessionState === 'attached') {
    logger.warn(`"${args.agent}" is attached — disabling it drops any client in \`quimby run\`.`)
  }
  if (sessionState !== 'stopped') {
    await killAgentTmuxSession(agent)
  }
  await setAgentEnabled(repoRoot, args.agent, false)

  logger.success(
    `Disabled "${args.agent}" — session freed, work kept on disk. Re-enable with \`quimby enable ${args.agent}\`.`,
  )
}
