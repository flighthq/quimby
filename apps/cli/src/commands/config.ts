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
    name: {
      type: 'positional',
      description: 'Agent name',
      required: true,
    },
  },
  run: runConfigCommand,
})

export async function runConfigCommand({ args }: { args: { name: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.name]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
  }

  const config = await runAgentWalkthrough(args.name, {
    runtime: agent.defaults?.runtime,
    entrypoint: agent.defaults?.entrypoint,
    location: agent.location,
    syncRef: agent.syncRef,
  })
  if (!config) return

  await setAgentDefaults(repoRoot, args.name, {
    runtime: config.runtime,
    entrypoint: config.entrypoint,
  })
  await setAgentLocation(repoRoot, args.name, config.location ?? { type: 'local' })
  await setAgentTmux(repoRoot, args.name, config.tmux ?? false)
  if (config.syncRef) {
    await setAgentSyncRef(repoRoot, args.name, config.syncRef)
  }

  logger.success(`Agent "${args.name}" configured`)
}
