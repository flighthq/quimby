import { defineCommand } from 'citty'
import { join } from 'pathe'

import { getTransport } from '../core/transport'
import { resolveWorkspace } from '../core/workspace'
import { isSSH } from '../types/location'
import { exists, readText } from '../utils/fs'
import { logger } from '../utils/logger'
import { getWorkerDir, remoteWorkerDir } from '../utils/paths'

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
  run,
})

async function run({ args }: { args: { name?: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const names = args.name ? [args.name] : Object.keys(state.workers)

  if (names.length === 0) {
    logger.info('No workers.')
    return
  }

  for (const name of names) {
    const worker = state.workers[name]
    if (!worker) {
      logger.warn(`Worker "${name}" not found`)
      continue
    }

    let statusContent = '(no status)'

    if (isSSH(worker.location)) {
      const transport = getTransport(worker.location)
      const rWorkerDir = remoteWorkerDir(state.id, name, worker.location.base)
      try {
        statusContent = (await transport.readFile(`${rWorkerDir}/status.md`)).trim() || '(empty)'
      } catch {
        statusContent = '(unreachable)'
      }
    } else {
      const statusPath = join(getWorkerDir(repoRoot, name), 'status.md')
      if (await exists(statusPath)) {
        statusContent = (await readText(statusPath)).trim() || '(empty)'
      }
    }

    console.log(`\n${bold(name)}`)
    console.log(statusContent)
  }
}
