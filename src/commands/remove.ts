import { defineCommand } from 'citty'
import { resolveWorkspace } from '../core/workspace.js'
import { removeWorker } from '../core/worker.js'
import { QuimbyError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove a worker (packs are kept)',
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

    await removeWorker(repoRoot, args.name)

    logger.success(`Worker "${args.name}" removed (packs preserved)`)
  },
})
