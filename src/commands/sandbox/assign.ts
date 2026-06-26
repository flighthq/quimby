import { defineCommand } from 'citty'
import { join } from 'pathe'
import { resolveWorkspace } from '../../core/workspace.js'
import { getSandboxMetaDir } from '../../utils/paths.js'
import { writeText, readText } from '../../utils/fs.js'
import { AoError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'assign',
    description: 'Push an assignment to a sandbox',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Sandbox name',
      required: true,
    },
    task: {
      type: 'positional',
      description: 'Task description (or @file to read from file)',
      required: true,
    },
  },
  async run({ args }) {
    const { state, workspacePath } = await resolveWorkspace()

    if (!state.sandboxes[args.name]) {
      throw new AoError(`Sandbox "${args.name}" not found`)
    }

    let taskContent = args.task

    if (taskContent.startsWith('@')) {
      const filePath = taskContent.slice(1)
      taskContent = await readText(filePath)
    }

    const metaDir = getSandboxMetaDir(workspacePath, args.name)
    await writeText(join(metaDir, 'assignment.md'), taskContent)

    logger.success(`Assignment pushed to "${args.name}"`)
    logger.info(
      taskContent.length > 80
        ? taskContent.slice(0, 80) + '...'
        : taskContent,
    )
  },
})
