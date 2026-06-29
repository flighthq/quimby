import { rebuildAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { logger } from '@quimbyhq/utils'
import { loadState, resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'rebuild',
    description:
      'Recreate an agent from current source (destructive — discards its work and mailbox)',
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
      description: 'Skip confirmation prompt',
      default: false,
    },
  },
  run: runRebuildCommand,
})

export async function runRebuildCommand({ args }: { args: { name: string; force: boolean } }) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.agents[args.name]) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
  }

  if (!args.force) {
    logger.warn(
      `This recreates "${args.name}" from scratch, discarding its work, inbox, and outbox. Pass --force (-f) to confirm.`,
    )
    return
  }

  await rebuildAgent(repoRoot, args.name)

  const newState = await loadState(repoRoot)
  const newSeed = newState.agents[args.name].seedCommit

  logger.success(`Agent "${args.name}" rebuilt (seed: ${newSeed.slice(0, 8)})`)
}
