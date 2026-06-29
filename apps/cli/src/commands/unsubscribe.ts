import { logger } from '@quimbyhq/utils'
import { resolveWorkspace, saveState } from '@quimbyhq/workspace'
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

  const subs = state.subscriptions ?? {}
  if (!subs[args.agent] || !subs[args.agent].includes(args.target)) {
    logger.info(`"${args.agent}" is not subscribed to "${args.target}"`)
    return
  }

  subs[args.agent] = subs[args.agent].filter((t) => t !== args.target)
  if (subs[args.agent].length === 0) delete subs[args.agent]
  state.subscriptions = subs
  await saveState(repoRoot, state)

  logger.success(`"${args.agent}" unsubscribed from "${args.target}"`)
}
