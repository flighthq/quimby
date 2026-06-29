import { QuimbyError } from '@quimbyhq/errors'
import { logger } from '@quimbyhq/utils'
import { resetWorker } from '@quimbyhq/worker'
import { loadState, resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'reset',
    description: 'Reset a worker to current HEAD (destructive — all uncommitted work is lost)',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Worker name',
      required: true,
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    },
  },
  run: runResetCommand,
})

export async function runResetCommand({ args }: { args: { name: string; force: boolean } }) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.workers[args.name]) {
    throw new QuimbyError(`Worker "${args.name}" not found`)
  }

  if (!args.force) {
    logger.warn(
      `This will destroy all uncommitted work in "${args.name}". Pass --force (-f) to confirm.`,
    )
    return
  }

  await resetWorker(repoRoot, args.name)

  const newState = await loadState(repoRoot)
  const newSeed = newState.workers[args.name].seedCommit

  logger.success(`Worker "${args.name}" reset (seed: ${newSeed.slice(0, 8)})`)
}
