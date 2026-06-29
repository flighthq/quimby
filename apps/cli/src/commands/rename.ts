import { renameAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'rename',
    description: 'Rename an agent',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Current agent name',
      required: true,
    },
    newName: {
      type: 'positional',
      description: 'New agent name',
      required: true,
    },
  },
  run: runRenameCommand,
})

export async function runRenameCommand({ args }: { args: { name: string; newName: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.agents[args.name]) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
  }

  await renameAgent(repoRoot, args.name, args.newName)
  logger.success(`Agent "${args.name}" renamed to "${args.newName}"`)
}
