import { resolveWorkspace, saveState } from '@quimby/core'
import { QuimbyError } from '@quimby/core'
import { logger } from '@quimby/core'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'subscribe',
    description: "Subscribe a worker to another worker's status updates",
  },
  args: {
    worker: {
      type: 'positional',
      description: 'Subscribing worker',
      required: true,
    },
    target: {
      type: 'positional',
      description: 'Target worker to watch',
      required: true,
    },
  },
  run,
})

async function run({ args }: { args: { worker: string; target: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.workers[args.worker]) {
    throw new QuimbyError(`Worker "${args.worker}" not found`)
  }
  if (!state.workers[args.target]) {
    throw new QuimbyError(`Worker "${args.target}" not found`)
  }
  if (args.worker === args.target) {
    throw new QuimbyError('A worker cannot subscribe to itself')
  }

  const subs = state.subscriptions ?? {}
  const targets = subs[args.worker] ?? []

  if (targets.includes(args.target)) {
    logger.info(`"${args.worker}" already subscribed to "${args.target}"`)
    return
  }

  targets.push(args.target)
  subs[args.worker] = targets
  state.subscriptions = subs
  await saveState(repoRoot, state)

  logger.success(`"${args.worker}" now receives status updates from "${args.target}"`)
}
