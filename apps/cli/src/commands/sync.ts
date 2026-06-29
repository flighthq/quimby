import { QuimbyError } from '@quimbyhq/errors'
import { remoteProjectRoot } from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
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
