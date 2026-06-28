import { defineCommand } from 'citty'

import { renameWorker } from '../core/worker'
import { resolveWorkspace } from '../core/workspace'
import { QuimbyError } from '../utils/errors'
import { logger } from '../utils/logger'

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
  run,
})

async function run({ args }: { args: { name: string; newName: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.workers[args.name]) {
    throw new QuimbyError(`Worker "${args.name}" not found`)
  }

  await renameWorker(repoRoot, args.name, args.newName)
  logger.success(`Worker "${args.name}" renamed to "${args.newName}"`)
}
