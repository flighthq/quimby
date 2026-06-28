import { defineCommand } from 'citty'

import { createPack, createRemotePack } from '../core/pack'
import { resolveWorkspace } from '../core/workspace'
import { isSSH } from '../types/location'
import { QuimbyError } from '../utils/errors'
import { logger } from '../utils/logger'

export default defineCommand({
  meta: {
    name: 'pack',
    description: "Package a worker's work into a pack",
  },
  args: {
    worker: {
      type: 'positional',
      description: 'Worker name',
      required: true,
    },
    name: {
      type: 'string',
      alias: 'n',
      description: 'Pack name (auto-generated if omitted)',
    },
    description: {
      type: 'string',
      alias: 'd',
      description: 'Pack description (inferred from commits if omitted)',
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Suggested commit message (inferred from commits if omitted)',
    },
  },
  run,
})

async function run({
  args,
}: {
  args: { worker: string; name?: string; description?: string; message?: string }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  const worker = state.workers[args.worker]
  if (!worker) {
    throw new QuimbyError(`Worker "${args.worker}" not found`)
  }

  const meta = isSSH(worker.location)
    ? await createRemotePack({
        repoRoot,
        workerName: args.worker,
        workerLocation: worker.location,
        projectId: state.id,
        packName: args.name,
        description: args.description,
        suggestedMessage: args.message,
      })
    : await createPack({
        repoRoot,
        workerName: args.worker,
        packName: args.name,
        description: args.description,
        suggestedMessage: args.message,
      })

  logger.success(
    `Pack "${meta.name}" created (${meta.commits.length} commit${meta.commits.length === 1 ? '' : 's'})`,
  )
}
