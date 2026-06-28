import { defineCommand } from 'citty'

import { removeWorker } from '../core/worker'
import { loadState, resolveWorkspace, saveState } from '../core/workspace'
import { isSSH } from '../types/location'
import { QuimbyError } from '../utils/errors'
import { logger } from '../utils/logger'

export default defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove a worker (packs are kept)',
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
      description: 'Skip remote cleanup (use when SSH host is unreachable)',
      default: false,
    },
  },
  run,
})

async function run({ args }: { args: { name: string; force: boolean } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const worker = state.workers[args.name]
  if (!worker) {
    throw new QuimbyError(`Worker "${args.name}" not found`)
  }

  if (isSSH(worker.location) && args.force) {
    // Skip remote cleanup — remove from state only
    const s = await loadState(repoRoot)
    delete s.workers[args.name]
    await saveState(repoRoot, s)
    logger.success(`Worker "${args.name}" removed from state (remote dir not cleaned up)`)
    return
  }

  await removeWorker(repoRoot, args.name)
  logger.success(`Worker "${args.name}" removed (packs preserved)`)
}
