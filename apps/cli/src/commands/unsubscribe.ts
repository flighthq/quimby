import { logger } from '@quimbyhq/utils'
import { removeSubscriptionFromState, resolveWorkspace, saveState } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'unsubscribe',
    description: 'Remove a subscription between agents',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Subscribing agent',
      required: true,
    },
    target: {
      type: 'positional',
      description: 'Target agent to stop watching',
      required: true,
    },
  },
  run: runUnsubscribeCommand,
})

export async function runUnsubscribeCommand({ args }: { args: { agent: string; target: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!removeSubscriptionFromState(state, args.agent, args.target)) {
    logger.info(`"${args.agent}" is not subscribed to "${args.target}"`)
    return
  }
  await saveState(repoRoot, state)

  logger.success(`"${args.agent}" unsubscribed from "${args.target}"`)
}
