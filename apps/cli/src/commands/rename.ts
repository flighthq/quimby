import { renameAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { renameAgentWindow } from '@quimbyhq/session'
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

  const agent = state.agents[args.name]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
  }

  await renameAgent(repoRoot, args.name, args.newName)
  logger.success(`Agent "${args.name}" renamed to "${args.newName}"`)

  // Rename is a pure relabel keyed by the stable UUID, so a live session survives it — but its
  // tmux window still shows the old label until the next run. Push the new name onto the live
  // window now (also updating any dashboard tab sharing it); a stopped agent just no-ops.
  if (await renameAgentWindow(agent, args.newName)) {
    logger.info(`Updated the live tmux window label to "${args.newName}"`)
  }
}
