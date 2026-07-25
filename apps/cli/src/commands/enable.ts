import { setAgentEnabled } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'enable',
    description: 'Re-enable a disabled agent so it rejoins layouts and launches',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent name',
      required: true,
    },
  },
  run: runEnableCommand,
})

export async function runEnableCommand({ args }: { args: { agent: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.agent]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }
  if (agent.enabled !== false) {
    logger.info(`"${args.agent}" is already enabled.`)
    return
  }

  // Clearing the flag only makes the agent eligible again; it does not launch it — the next
  // `quimby run`/`start` brings it back, resuming from its status.md.
  await setAgentEnabled(repoRoot, args.agent, true)

  logger.success(
    `Enabled "${args.agent}". Bring it up with \`quimby run ${args.agent}\` (or a dashboard run).`,
  )
}
