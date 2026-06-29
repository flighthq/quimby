import { QuimbyError } from '@quimbyhq/errors'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace, saveState } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'subscribe',
    description: "Subscribe an agent to another agent's status updates",
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Subscribing agent',
      required: true,
    },
    target: {
      type: 'positional',
      description: 'Target agent to watch',
      required: true,
    },
  },
  run: runSubscribeCommand,
})

export async function runSubscribeCommand({ args }: { args: { agent: string; target: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.agents[args.agent]) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }
  if (!state.agents[args.target]) {
    throw new QuimbyError(`Agent "${args.target}" not found`)
  }
  if (args.agent === args.target) {
    throw new QuimbyError('An agent cannot subscribe to itself')
  }

  const subs = state.subscriptions ?? {}
  const targets = subs[args.agent] ?? []

  if (targets.includes(args.target)) {
    logger.info(`"${args.agent}" already subscribed to "${args.target}"`)
    return
  }

  targets.push(args.target)
  subs[args.agent] = targets
  state.subscriptions = subs
  await saveState(repoRoot, state)

  logger.success(`"${args.agent}" now receives status updates from "${args.target}"`)
}
