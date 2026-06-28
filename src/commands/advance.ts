import { defineCommand } from 'citty'

import { advanceWorker } from '../core/worker'
import { resolveWorkspace } from '../core/workspace'
import { QuimbyError } from '../utils/errors'
import { logger } from '../utils/logger'

export default defineCommand({
  meta: {
    name: 'advance',
    description:
      'Fast-forward a worker repo to current host HEAD, preserving assignment and status',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Worker name',
      required: true,
    },
  },
  run,
})

async function run({ args }: { args: { name: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.workers[args.name]) {
    throw new QuimbyError(`Worker "${args.name}" not found`)
  }

  logger.start(`Advancing worker "${args.name}"`)

  const result = await advanceWorker(repoRoot, args.name)

  if (result.newSeed === state.workers[args.name].seedCommit) {
    logger.info(`Worker "${args.name}" is already up to date`)
    return
  }

  const seedShort = result.newSeed.slice(0, 8)
  if (result.rebased) {
    logger.success(
      `Worker "${args.name}" advanced: ${result.commitsReplayed} commit(s) rebased onto ${seedShort}`,
    )
  } else {
    logger.success(`Worker "${args.name}" fast-forwarded to ${seedShort}`)
  }
}
