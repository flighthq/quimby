import { defineCommand } from 'citty'
import * as git from '../utils/git.js'
import { addWorker } from '../core/worker.js'
import { QuimbyError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'add',
    description: 'Create a new worker',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Name for the worker',
      required: true,
    },
  },
  async run({ args }) {
    const repoRoot = await git.findRoot(process.cwd())
    if (!repoRoot) {
      throw new QuimbyError('Not inside a git repository.')
    }

    const workerState = await addWorker(repoRoot, args.name)
    logger.success(`Worker "${args.name}" created (seed: ${workerState.seedCommit.slice(0, 8)})`)
  },
})
