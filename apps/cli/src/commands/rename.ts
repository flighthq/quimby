import { QuimbyError } from '@quimbyhq/errors'
import { logger } from '@quimbyhq/utils'
import { renameWorker } from '@quimbyhq/worker'
import { resolveWorkspace } from '@quimbyhq/workspace'
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
  run: runRenameCommand,
})

export async function runRenameCommand({ args }: { args: { name: string; newName: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.workers[args.name]) {
    throw new QuimbyError(`Worker "${args.name}" not found`)
  }

  await renameWorker(repoRoot, args.name, args.newName)
  logger.success(`Worker "${args.name}" renamed to "${args.newName}"`)
}
