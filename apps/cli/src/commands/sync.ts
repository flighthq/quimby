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
    description: 'Rsync local project to a remote SSH agent',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Agent name',
      required: true,
    },
  },
  run: runSyncCommand,
})

export async function runSyncCommand({ args }: { args: { name: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.name]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
  }

  if (!isSSH(agent.location)) {
    throw new QuimbyError(`Agent "${args.name}" is a local agent — sync only applies to SSH agents`)
  }

  const rRoot = remoteProjectRoot(state.id, agent.location.base)
  const transport = getSSHTransport(agent.location)
  logger.start(`Syncing to ${agent.location.host}:${rRoot}`)
  await transport.syncProjectTo(repoRoot, rRoot)
  await transport.ensureDir(`${rRoot}/.quimby/packs`)
  logger.success(`Synced to ${agent.location.host}`)
}
