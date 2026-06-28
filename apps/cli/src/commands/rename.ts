import { renameWorker } from '@quimby/core'
import { resolveWorkspace } from '@quimby/core'
import { QuimbyError } from '@quimby/core'
import { logger } from '@quimby/core'
import { defineCommand } from 'citty'

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
