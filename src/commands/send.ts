import { defineCommand } from 'citty'

import { sendPack } from '../core/pack'
import { getSSHTransport } from '../core/transport'
import { resolveWorkspace } from '../core/workspace'
import { isSSH } from '../types/location'
import { QuimbyError } from '../utils/errors'
import { logger } from '../utils/logger'
import { getPackDir, remoteWorkerDir } from '../utils/paths'

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
  run,
})

async function run({ args }: { args: { worker: string; pack: string } }) {
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
