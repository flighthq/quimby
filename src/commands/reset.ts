import { defineCommand } from 'citty'

import { resetWorker } from '../core/worker'
import { loadState, resolveWorkspace } from '../core/workspace'
import { QuimbyError } from '../utils/errors'
import { logger } from '../utils/logger'

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
  run,
})

async function run({ args }: { args: { name: string; force: boolean } }) {
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
