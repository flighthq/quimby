import { defineCommand } from 'citty'
import { resolveWorkspace } from '../core/workspace.js'
import { renameWorker } from '../core/worker.js'
import { QuimbyError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'rename',
    description: 'Rename a worker',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Current worker name',
      required: true,
    },
    newName: {
      type: 'positional',
      description: 'New worker name',
      required: true,
    },
  },
  async run({ args }) {
    const { state, repoRoot } = await resolveWorkspace()

    if (!state.workers[args.name]) {
      throw new QuimbyError(`Worker "${args.name}" not found`)
    }

    await renameWorker(repoRoot, args.name, args.newName)

    logger.success(`Worker "${args.name}" renamed to "${args.newName}"`)
  },
})
