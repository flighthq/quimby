import { removeAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { loadState, resolveWorkspace, saveState } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove an agent',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Agent name',
      required: true,
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Skip remote cleanup (use when SSH host is unreachable)',
      default: false,
    },
  },
  run: runRemoveCommand,
})

export async function runRemoveCommand({ args }: { args: { name: string; force: boolean } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.name]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
  }

  if (isSSH(agent.location) && args.force) {
    // Skip remote cleanup — remove from state only
    const s = await loadState(repoRoot)
    delete s.agents[args.name]
    await saveState(repoRoot, s)
    logger.success(`Agent "${args.name}" removed from state (remote dir not cleaned up)`)
    return
  }

  await removeAgent(repoRoot, args.name)
  logger.success(`Agent "${args.name}" removed`)
}
