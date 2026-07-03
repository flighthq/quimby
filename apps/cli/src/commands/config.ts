import { setAgentDefaults, setAgentLocation, setAgentSyncRef, setAgentTmux } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { runAgentWalkthrough } from '../walkthrough'

export default defineCommand({
  meta: {
    name: 'config',
    description: 'Configure an agent interactively (runtime, entrypoint, location, …)',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent name',
      required: true,
    },
  },
  run: runConfigCommand,
})

export async function runConfigCommand({ args }: { args: { agent: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.agent]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }

  const config = await runAgentWalkthrough(args.agent, {
    runtime: agent.defaults?.runtime,
    entrypoint: agent.defaults?.entrypoint,
    location: agent.location,
    syncRef: agent.syncRef,
  })
  if (!config) return

  await setAgentDefaults(repoRoot, args.agent, {
    runtime: config.runtime,
    entrypoint: config.entrypoint,
  })
  await setAgentLocation(repoRoot, args.agent, config.location ?? { type: 'local' })
  await setAgentTmux(repoRoot, args.agent, config.tmux ?? false)
  if (config.syncRef) {
    await setAgentSyncRef(repoRoot, args.agent, config.syncRef)
  }

  logger.success(`Agent "${args.agent}" configured`)
}
