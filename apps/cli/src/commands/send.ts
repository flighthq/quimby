import { QuimbyError } from '@quimbyhq/errors'
import { sendPack } from '@quimbyhq/pack'
import { getPackDir, remoteWorkerDir } from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'send',
    description: "Send a pack to a worker's inbox",
  },
  args: {
    worker: {
      type: 'positional',
      description: 'Destination worker',
      required: true,
    },
    pack: {
      type: 'positional',
      description: 'Pack name',
      required: true,
    },
  },
  run: runSendCommand,
})

export async function runSendCommand({ args }: { args: { worker: string; pack: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const worker = state.workers[args.worker]
  if (!worker) {
    throw new QuimbyError(`Worker "${args.worker}" not found`)
  }

  if (isSSH(worker.location)) {
    const transport = getSSHTransport(worker.location)
    const localPackDir = getPackDir(repoRoot, args.pack)
    const rInboxDir = `${remoteWorkerDir(state.id, args.worker, worker.location.base)}/inbox/packs/${args.pack}`
    await transport.ensureDir(rInboxDir)
    await transport.rsyncTo(localPackDir, rInboxDir)
  } else {
    await sendPack({ repoRoot, packName: args.pack, workerName: args.worker })
  }

  logger.success(`Pack "${args.pack}" sent to "${args.worker}"`)
}
