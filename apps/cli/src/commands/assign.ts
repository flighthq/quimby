import { QuimbyError } from '@quimbyhq/errors'
import { sendPack } from '@quimbyhq/pack'
import { getPackDir, getWorkerDir, remoteWorkerDir } from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import { isSSH } from '@quimbyhq/types'
import { readText, writeText } from '@quimbyhq/utils'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { join } from 'pathe'

export default defineCommand({
  meta: {
    name: 'assign',
    description: 'Push an assignment to a worker',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Worker name',
      required: true,
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Assignment message',
    },
    pack: {
      type: 'string',
      alias: 'p',
      description: 'Pack to attach (sends to worker inbox)',
    },
  },
  run,
})

async function run({ args }: { args: { name: string; message?: string; pack?: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const worker = state.workers[args.name]
  if (!worker) {
    throw new QuimbyError(`Worker "${args.name}" not found`)
  }

  const packNames: string[] = []

  if (args.pack) {
    const names = Array.isArray(args.pack) ? args.pack : [args.pack]
    for (const packName of names) {
      if (isSSH(worker.location)) {
        const transport = getSSHTransport(worker.location)
        const localPackDir = getPackDir(repoRoot, packName)
        const rInboxDir = `${remoteWorkerDir(state.id, args.name, worker.location.base)}/inbox/packs/${packName}`
        await transport.ensureDir(rInboxDir)
        await transport.rsyncTo(localPackDir, rInboxDir)
      } else {
        await sendPack({ repoRoot, packName, workerName: args.name })
      }
      packNames.push(packName)
    }
  }

  let taskContent = args.message ?? ''

  if (taskContent.startsWith('@')) {
    taskContent = await readText(taskContent.slice(1))
  }

  if (!taskContent && packNames.length > 0) {
    taskContent =
      packNames.length === 1
        ? `Please review the following pack: ${packNames[0]}`
        : `Please review the following packs: ${packNames.join(', ')}`
  }

  if (!taskContent) {
    throw new QuimbyError('Provide a message with -m or attach a pack with -p')
  }

  if (isSSH(worker.location)) {
    const transport = getSSHTransport(worker.location)
    const rWorkerDir = remoteWorkerDir(state.id, args.name, worker.location.base)
    await transport.writeFile(`${rWorkerDir}/assignment.md`, taskContent)
  } else {
    const workerDir = getWorkerDir(repoRoot, args.name)
    await writeText(join(workerDir, 'assignment.md'), taskContent)
  }

  logger.success(`Assignment pushed to "${args.name}"`)
  if (packNames.length > 0) {
    logger.info(`Packs sent: ${packNames.join(', ')}`)
  }
}
