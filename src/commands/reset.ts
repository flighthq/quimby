import { defineCommand } from 'citty'
import { resolveWorkspace } from '../core/workspace.js'
import { resetWorker } from '../core/worker.js'
import { QuimbyError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'reset',
    description: 'Reset a worker to current HEAD (destructive)',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Worker name',
      required: true,
    },
  },
  async run({ args }) {
    const { state, repoRoot } = await resolveWorkspace()

    if (!state.workers[args.name]) {
      throw new QuimbyError(`Worker "${args.name}" not found`)
    }

    logger.warn(`Resetting worker "${args.name}" — all uncommitted work will be lost`)

    await resetWorker(repoRoot, args.name)

    const updated = (await import('../core/workspace.js')).loadState
    const newState = await updated(repoRoot)
    const newSeed = newState.workers[args.name].seedCommit

    logger.success(`Worker "${args.name}" reset (seed: ${newSeed.slice(0, 8)})`)
  },
})
