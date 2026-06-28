import { getSSHTransport } from '@quimby/core'
import { resolveWorkspace } from '@quimby/core'
import { QuimbyError } from '@quimby/core'
import { logger } from '@quimby/core'
import { remoteProjectRoot } from '@quimby/core'
import { isSSH } from '@quimby/types'
import { defineCommand } from 'citty'

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
  const transport = getSSHTransport(worker.location)
  logger.start(`Syncing to ${worker.location.host}:${rRoot}`)
  await transport.syncProjectTo(repoRoot, rRoot)
  await transport.ensureDir(`${rRoot}/.quimby/packs`)
  logger.success(`Synced to ${worker.location.host}`)
}
