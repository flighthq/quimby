import {
  setAgentDefaults,
  setAgentLocation,
  setAgentRole,
  setAgentRuntimeProfile,
  setAgentSyncRef,
  setAgentTmux,
} from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { logger } from '@quimbyhq/utils'
import { loadQuimbyConfig, resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { resolveWalkthroughConfig, runAgentWalkthrough } from '../walkthrough'

export default defineCommand({
  meta: {
    name: 'config',
    description: 'Configure an agent interactively (role, engine, location, …)',
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

  const config = await loadQuimbyConfig(repoRoot)
  const result = await runAgentWalkthrough(args.agent, config, repoRoot, {
    role: agent.role,
    // Seed from the agent's *authoritative* engine so reconfigure shows its real current state:
    // a pin, else a flattened profile, else raw runtime/entrypoint.
    runtimeProfile: agent.runtimeProfile ?? agent.defaults?.runtimeProfile,
    runtime: agent.defaults?.runtime,
    entrypoint: agent.defaults?.entrypoint,
    location: agent.location,
    syncRef: agent.syncRef,
    tmux: agent.tmux,
  })
  if (!result) return

  // Persist one coherent engine authority and clear the others, so the choice actually takes
  // effect (a stale `defaults` would be ignored under a role/pin at launch).
  const resolved = resolveWalkthroughConfig(result)
  await setAgentRole(repoRoot, args.agent, resolved.role)
  await setAgentRuntimeProfile(repoRoot, args.agent, resolved.runtimeProfile)
  await setAgentDefaults(repoRoot, args.agent, {
    runtime: resolved.defaults?.runtime,
    entrypoint: resolved.defaults?.entrypoint,
    runtimeProfile: undefined,
  })
  await setAgentLocation(repoRoot, args.agent, resolved.location)
  await setAgentTmux(repoRoot, args.agent, resolved.tmux ?? false)
  if (resolved.syncRef) {
    await setAgentSyncRef(repoRoot, args.agent, resolved.syncRef)
  }

  logger.success(`Agent "${args.agent}" configured`)
}
