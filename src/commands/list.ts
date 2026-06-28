import { readdir } from 'node:fs/promises'

import { defineCommand } from 'citty'

import { getServerInfo } from '../core/client'
import { listPacks } from '../core/pack'
import { resolveWorkspace } from '../core/workspace'
import { isSSH } from '../types/location'
import { exists } from '../utils/fs'
import * as git from '../utils/git'
import { logger } from '../utils/logger'
import { getWorkerOutboxDir, tmuxSessionName } from '../utils/paths'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

export default defineCommand({
  meta: {
    name: 'list',
    description: 'List workers, packs, and subscriptions',
  },
  run,
})

async function run() {
  const { state, repoRoot } = await resolveWorkspace()

  const workerNames = Object.keys(state.workers)
  const packs = await listPacks(repoRoot)
  const subs = state.subscriptions ?? {}
  const subEntries = Object.entries(subs)

  if (workerNames.length === 0 && packs.length === 0) {
    logger.info('No workers or packs. Run `quimby add <name>` to create a worker.')
    return
  }

  const hostHead = await git.getCurrentRef(repoRoot)

  if (workerNames.length > 0) {
    console.log(bold('Workers'))
    for (const name of workerNames) {
      const worker = state.workers[name]
      const defaults = worker.defaults

      let behindStr = ''
      if (worker.seedCommit && worker.seedCommit !== hostHead) {
        const behind = await git.countCommits(repoRoot, `${worker.seedCommit}..${hostHead}`)
        if (behind > 0) {
          behindStr = `  ${yellow(`${behind} behind`)}`
        }
      }

      let locationStr = ''
      if (isSSH(worker.location)) {
        const session = tmuxSessionName(state.id, worker.id)
        locationStr = `  ${cyan(`[ssh: ${worker.location.host}]`)} ${dim(`tmux: ${session}`)}`
      }

      const config = defaults
        ? dim(`${defaults.runtime ?? 'local'} / ${defaults.agent ?? 'claude'}`)
        : dim('no defaults — run `quimby set`')

      const outboxDir = getWorkerOutboxDir(repoRoot, name)
      let outboxStr = ''
      if (await exists(outboxDir)) {
        const drafts = (await readdir(outboxDir)).filter((e) => e.endsWith('.md'))
        if (drafts.length > 0) {
          outboxStr = `  ${cyan(`outbox: ${drafts.length}`)}`
        }
      }

      console.log(
        `  ${name}  ${dim(worker.seedCommit.slice(0, 8))}  ${config}${locationStr}${outboxStr}${behindStr}`,
      )
    }
  }

  if (packs.length > 0) {
    if (workerNames.length > 0) console.log()
    console.log(bold('Packs'))
    for (const pack of packs) {
      const desc =
        pack.description.length > 60 ? pack.description.slice(0, 57) + '...' : pack.description
      console.log(`  ${pack.name}  ${dim(`from: ${pack.worker}`)}  ${desc}`)
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
}
