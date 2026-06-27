import { defineCommand } from 'citty'
import { resolveWorkspace } from '../core/workspace.js'
import { sendPack } from '../core/pack.js'
import { QuimbyError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'send',
    description: "Send a pack to a worker's inbox",
  },
  args: {
    worker: {
      type: 'positional',
      description: 'Destination worker',
      required: true,
    },
    pack: {
      type: 'positional',
      description: 'Pack name',
      required: true,
    },
  },
  async run({ args }) {
    const { state, repoRoot } = await resolveWorkspace()

    if (!state.workers[args.worker]) {
      throw new QuimbyError(`Worker "${args.worker}" not found`)
    }

    await sendPack({
      repoRoot,
      packName: args.pack,
      workerName: args.worker,
    })

    logger.success(`Pack "${args.pack}" sent to "${args.worker}"`)
  },
})
