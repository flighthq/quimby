import { defineCommand } from 'citty'
import { resolveWorkspace, saveState } from '../core/workspace.js'
import { QuimbyError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'unsubscribe',
    description: 'Remove a subscription between workers',
  },
  args: {
    worker: {
      type: 'positional',
      description: 'Subscribing worker',
      required: true,
    },
    target: {
      type: 'positional',
      description: 'Target worker to stop watching',
      required: true,
    },
  },
  async run({ args }) {
    const { state, repoRoot } = await resolveWorkspace()

    const subs = state.subscriptions ?? {}
    if (!subs[args.worker] || !subs[args.worker].includes(args.target)) {
      logger.info(`"${args.worker}" is not subscribed to "${args.target}"`)
      return
    }

    subs[args.worker] = subs[args.worker].filter((t) => t !== args.target)
    if (subs[args.worker].length === 0) delete subs[args.worker]
    state.subscriptions = subs
    await saveState(repoRoot, state)

    logger.success(`"${args.worker}" unsubscribed from "${args.target}"`)
  },
})
