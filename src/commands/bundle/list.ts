import { defineCommand } from 'citty'
import { resolveWorkspace } from '../../core/workspace.js'
import { listBundles } from '../../core/bundle.js'
import { getSandboxPath } from '../../utils/paths.js'
import { logger } from '../../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'list',
    description: 'List bundles from sandboxes',
  },
  args: {
    sandbox: {
      type: 'positional',
      description: 'Sandbox name (omit to show all)',
      required: false,
    },
  },
  async run({ args }) {
    const { state, workspacePath } = await resolveWorkspace()

    const names = args.sandbox
      ? [args.sandbox]
      : Object.keys(state.sandboxes)

    let totalBundles = 0

    for (const name of names) {
      const sandboxPath = getSandboxPath(workspacePath, name)
      const bundles = await listBundles(sandboxPath)

      if (bundles.length === 0) continue

      console.log(`\n[${name}]`)
      for (const b of bundles) {
        console.log(
          `  ${b.id}  ${b.description}  (${b.commits.length} commit${b.commits.length === 1 ? '' : 's'}, ${b.createdAt.slice(0, 10)})`,
        )
      }
      totalBundles += bundles.length
    }

    if (totalBundles === 0) {
      logger.info('No bundles found.')
    }
  },
})
