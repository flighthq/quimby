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
    agent: {
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

export async function runRebuildCommand({ args }: { args: { agent: string; force: boolean } }) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.agents[args.agent]) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }

  if (!args.force) {
    logger.warn(
      `This recreates "${args.agent}" from scratch, discarding its work and handoff mailbox. Pass --force (-f) to confirm.`,
    )
    return
  }

  await rebuildAgent(repoRoot, args.agent)

  const newState = await loadState(repoRoot)
  const newSeed = newState.agents[args.agent].seedCommit

  logger.success(`Agent "${args.agent}" rebuilt (seed: ${newSeed.slice(0, 8)})`)
}
