import { defineCommand } from 'citty'
import { resolveWorkspace } from '../core/workspace.js'
import { createPack } from '../core/pack.js'
import { QuimbyError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'pack',
    description: "Package a worker's work into a pack",
  },
  args: {
    worker: {
      type: 'positional',
      description: 'Worker name',
      required: true,
    },
    name: {
      type: 'string',
      alias: 'n',
      description: 'Pack name (auto-generated if omitted)',
    },
    description: {
      type: 'string',
      alias: 'd',
      description: 'Pack description (inferred from commits if omitted)',
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Suggested commit message (inferred from commits if omitted)',
    },
  },
  async run({ args }) {
    const { state, repoRoot } = await resolveWorkspace()

    if (!state.workers[args.worker]) {
      throw new QuimbyError(`Worker "${args.worker}" not found`)
    }

    const meta = await createPack({
      repoRoot,
      workerName: args.worker,
      packName: args.name,
      description: args.description,
      suggestedMessage: args.message,
    })

    logger.success(`Pack "${meta.name}" created (${meta.commits.length} commit${meta.commits.length === 1 ? '' : 's'})`)
  },
})
