import { readdir } from 'node:fs/promises'

import * as git from '@quimbyhq/git'
import { listPacks } from '@quimbyhq/pack'
import { getWorkerOutboxDir, tmuxSessionName } from '@quimbyhq/paths'
import { getServerInfo } from '@quimbyhq/server'
import { isSSH } from '@quimbyhq/types'
import { exists } from '@quimbyhq/utils'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

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

  if (workerNames.length > 0) {
    console.log(bold('Workers'))
    for (const name of workerNames) {
      const worker = state.workers[name]
      const defaults = worker.defaults

      // "behind" is measured against the worker's sync target, not the host's
      // live HEAD — that is the commit `quimby advance` would move it onto.
      const syncRef = worker.syncRef ?? state.sourceRef
      const target = await git.revParse(repoRoot, syncRef).catch(() => undefined)

      let behindStr = ''
      if (target && worker.seedCommit && worker.seedCommit !== target) {
        const behind = await git.countCommits(repoRoot, `${worker.seedCommit}..${target}`)
        if (behind > 0) {
          behindStr = `  ${yellow(`${behind} behind`)}`
        }
      }

      const syncStr = syncRef !== state.sourceRef ? `  ${dim(`↟ ${syncRef}`)}` : ''

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
        `  ${name}  ${dim(worker.seedCommit.slice(0, 8))}  ${config}${locationStr}${syncStr}${outboxStr}${behindStr}`,
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
