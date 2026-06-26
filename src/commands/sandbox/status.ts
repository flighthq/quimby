import { defineCommand } from 'citty'
import { join } from 'pathe'
import { resolveWorkspace } from '../../core/workspace.js'
import { getSandboxMetaDir } from '../../utils/paths.js'
import { readText, exists } from '../../utils/fs.js'
import { logger } from '../../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show sandbox status',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Sandbox name (omit to show all)',
      required: false,
    },
  },
  async run({ args }) {
    const { state, workspacePath } = await resolveWorkspace()

    const names = args.name
      ? [args.name]
      : Object.keys(state.sandboxes)

    for (const name of names) {
      const sandboxState = state.sandboxes[name]
      if (!sandboxState) {
        logger.warn(`Sandbox "${name}" not found`)
        continue
      }

      const metaDir = getSandboxMetaDir(workspacePath, name)
      const statusPath = join(metaDir, 'status.md')

      let statusContent = '(no status)'
      if (await exists(statusPath)) {
        statusContent = (await readText(statusPath)).trim() || '(empty)'
      }

      console.log(`\n[${name}] (${sandboxState.status})`)
      console.log(statusContent)
    }
  },
})
