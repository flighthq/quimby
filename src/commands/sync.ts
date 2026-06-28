import { defineCommand } from 'citty'

import { getSSHTransport, syncToRemote } from '../core/transport'
import { resolveWorkspace } from '../core/workspace'
import { isSSH } from '../types/location'
import { QuimbyError } from '../utils/errors'
import { logger } from '../utils/logger'
import { remoteProjectRoot } from '../utils/paths'

export default defineCommand({
  meta: {
    name: 'sync',
    description: 'Rsync local project to a remote SSH worker',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Worker name',
      required: true,
    },
  },
  run,
})

async function run({ args }: { args: { name: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const worker = state.workers[args.name]
  if (!worker) {
    throw new QuimbyError(`Worker "${args.name}" not found`)
  }

  if (!isSSH(worker.location)) {
    throw new QuimbyError(
      `Worker "${args.name}" is a local worker — sync only applies to SSH workers`,
    )
  }

  const rRoot = remoteProjectRoot(state.id, worker.location.base)
  logger.start(`Syncing to ${worker.location.host}:${rRoot}`)
  await syncToRemote(repoRoot, rRoot, worker.location)

  const transport = getSSHTransport(worker.location)
  await transport.ensureDir(`${rRoot}/.quimby/packs`)
  logger.success(`Synced to ${worker.location.host}`)
}
