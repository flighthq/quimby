import { defineCommand } from 'citty'
import { resolveWorkspace } from '../core/workspace.js'
import { listPacks } from '../core/pack.js'
import { getServerInfo } from '../core/client.js'
import { logger } from '../utils/logger.js'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

export default defineCommand({
  meta: {
    name: 'list',
    description: 'List workers, packs, and subscriptions',
  },
  async run() {
    const { state, repoRoot } = await resolveWorkspace()

    const workerNames = Object.keys(state.workers)
    const packs = await listPacks(repoRoot)
    const subs = state.subscriptions ?? {}
    const subEntries = Object.entries(subs)

    if (workerNames.length === 0 && packs.length === 0) {
      logger.info('No workers or packs. Run `quimby add <name>` to create a worker.')
      return
    }

    if (workerNames.length > 0) {
      console.log(bold('Workers'))
      for (const name of workerNames) {
        const worker = state.workers[name]
        console.log(`  ${name}  ${dim(worker.seedCommit.slice(0, 8))}`)
      }
    }

    if (packs.length > 0) {
      if (workerNames.length > 0) console.log()
      console.log(bold('Packs'))
      for (const pack of packs) {
        const desc = pack.description.length > 60
          ? pack.description.slice(0, 57) + '...'
          : pack.description
        console.log(
          `  ${pack.name}  ${dim(`from: ${pack.worker}`)}  ${desc}`,
        )
      }
    }

    if (subEntries.length > 0) {
      console.log()
      console.log(bold('Subscriptions'))
      for (const [subscriber, targets] of subEntries) {
        for (const target of targets) {
          console.log(`  ${subscriber} ${dim('←')} ${target}`)
        }
      }
    }

    const serverInfo = await getServerInfo(repoRoot)
    if (serverInfo) {
      console.log()
      console.log(dim(`Server running on :${serverInfo.port} (PID: ${serverInfo.pid})`))
    }
  },
})
