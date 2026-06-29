import { readdir } from 'node:fs/promises'

import * as git from '@quimbyhq/git'
import { getAgentOutboxDir, tmuxSessionName } from '@quimbyhq/paths'
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
    description: 'List agents and subscriptions',
  },
  run: runListCommand,
})

export async function runListCommand() {
  const { state, repoRoot } = await resolveWorkspace()

  const agentNames = Object.keys(state.agents)
  const subs = state.subscriptions ?? {}
  const subEntries = Object.entries(subs)

  if (agentNames.length === 0) {
    logger.info('No agents. Run `quimby add <name>` to create an agent.')
    return
  }

  if (agentNames.length > 0) {
    console.log(bold('Agents'))
    for (const name of agentNames) {
      const agent = state.agents[name]
      const defaults = agent.defaults

      // "behind" is measured against the agent's sync target, not the host's
      // live HEAD — that is the commit `quimby sync` would move it onto.
      const syncRef = agent.syncRef ?? state.sourceRef
      const target = await git.revParse(repoRoot, syncRef).catch(() => undefined)

      let behindStr = ''
      if (target && agent.seedCommit && agent.seedCommit !== target) {
        const behind = await git.countCommits(repoRoot, `${agent.seedCommit}..${target}`)
        if (behind > 0) {
          behindStr = `  ${yellow(`${behind} behind`)}`
        }
      }

      const syncStr = syncRef !== state.sourceRef ? `  ${dim(`↟ ${syncRef}`)}` : ''

      let locationStr = ''
      if (isSSH(agent.location)) {
        const session = tmuxSessionName(state.id, agent.id)
        locationStr = `  ${cyan(`[ssh: ${agent.location.host}]`)} ${dim(`tmux: ${session}`)}`
      }

      const config = defaults
        ? dim(`${defaults.runtime ?? 'local'} / ${defaults.entrypoint ?? 'claude'}`)
        : dim('no defaults — run `quimby set`')

      const outboxDir = getAgentOutboxDir(repoRoot, name)
      let outboxStr = ''
      if (await exists(outboxDir)) {
        const drafts = (await readdir(outboxDir, { withFileTypes: true })).filter(
          (e) => e.isDirectory() && !e.name.startsWith('.'),
        )
        if (drafts.length > 0) {
          outboxStr = `  ${cyan(`outbox: ${drafts.length}`)}`
        }
      }

      console.log(
        `  ${name}  ${dim(agent.seedCommit.slice(0, 8))}  ${config}${locationStr}${syncStr}${outboxStr}${behindStr}`,
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
}
