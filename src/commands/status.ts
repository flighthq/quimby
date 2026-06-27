import { defineCommand } from 'citty'
import { join } from 'pathe'
import { resolveWorkspace } from '../core/workspace.js'
import { getWorkerDir } from '../utils/paths.js'
import { readText, exists } from '../utils/fs.js'
import { logger } from '../utils/logger.js'

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show agent-written status for workers',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Worker name (omit to show all)',
      required: false,
    },
  },
  async run({ args }) {
    const { state, repoRoot } = await resolveWorkspace()

    const names = args.name
      ? [args.name]
      : Object.keys(state.workers)

    if (names.length === 0) {
      logger.info('No workers.')
      return
    }

    for (const name of names) {
      if (!state.workers[name]) {
        logger.warn(`Worker "${name}" not found`)
        continue
      }

      const workerDir = getWorkerDir(repoRoot, name)
      const statusPath = join(workerDir, 'status.md')

      let statusContent = '(no status)'
      if (await exists(statusPath)) {
        statusContent = (await readText(statusPath)).trim() || '(empty)'
      }

      console.log(`\n${bold(name)}`)
      console.log(statusContent)
    }
  },
})
