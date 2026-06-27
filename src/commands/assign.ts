import { defineCommand } from 'citty'
import { join } from 'pathe'
import { resolveWorkspace } from '../core/workspace.js'
import { sendPack } from '../core/pack.js'
import { getWorkerDir } from '../utils/paths.js'
import { writeText, readText } from '../utils/fs.js'
import { QuimbyError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

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
  async run({ args }) {
    const { state, repoRoot } = await resolveWorkspace()

    if (!state.workers[args.name]) {
      throw new QuimbyError(`Worker "${args.name}" not found`)
    }

    const packNames: string[] = []

    if (args.pack) {
      const names = Array.isArray(args.pack) ? args.pack : [args.pack]
      for (const packName of names) {
        await sendPack({ repoRoot, packName, workerName: args.name })
        packNames.push(packName)
      }
    }

    let taskContent = args.message ?? ''

    if (taskContent.startsWith('@')) {
      taskContent = await readText(taskContent.slice(1))
    }

    if (!taskContent && packNames.length > 0) {
      taskContent = packNames.length === 1
        ? `Please review the following pack: ${packNames[0]}`
        : `Please review the following packs: ${packNames.join(', ')}`
    }

    if (!taskContent) {
      throw new QuimbyError(
        'Provide a message with -m or attach a pack with -p',
      )
    }

    const workerDir = getWorkerDir(repoRoot, args.name)
    await writeText(join(workerDir, 'assignment.md'), taskContent)

    logger.success(`Assignment pushed to "${args.name}"`)
    if (packNames.length > 0) {
      logger.info(`Packs sent: ${packNames.join(', ')}`)
    }
  },
})
