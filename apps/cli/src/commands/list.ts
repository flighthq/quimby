import { getAgentPendingWork, getAgentSyncStatus } from '@quimbyhq/agent'
import { readOutboxRecipients } from '@quimbyhq/handoff'
import { resolveRuntimeSelection } from '@quimbyhq/launch'
import { tmuxSessionName } from '@quimbyhq/paths'
import { getServerInfo } from '@quimbyhq/server'
import { getAgentSessionState } from '@quimbyhq/session'
import type { AgentSessionState, AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { loadQuimbyConfig, resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { bold, cyan, dim, green, yellow } from '../colors'
import { withRemoteProbeTimeout } from '../remoteProbe'

export default defineCommand({
  meta: {
    name: 'list',
    description: 'List agents with their live session state',
  },
  run: runListCommand,
})

export async function runListCommand() {
  const { state, repoRoot } = await resolveWorkspace()
  // Load config once so the engine column reflects the *resolved* launch command (role +
  // per-instance profile pin, config-fresh) rather than the stale stored `defaults` snapshot.
  const quimbyConfig = await loadQuimbyConfig(repoRoot).catch(() => undefined)

  const agentNames = Object.keys(state.agents)

  if (agentNames.length === 0) {
    logger.info('No agents. Run `quimby add <name>` to create an agent.')
    return
  }

  if (agentNames.length > 0) {
    console.log(bold('Agents'))
    for (const name of agentNames) {
      const agent = state.agents[name]
      const defaults = agent.defaults

      const [syncStatus, pending, outboxDrafts, sessionState] = await Promise.all([
        maybeBoundRemoteProbe(
          agent,
          getAgentSyncStatus(repoRoot, agent, state.sourceRef).catch(() => ({
            behind: 0,
            syncRef: agent.syncRef ?? state.sourceRef,
            targetCommit: '',
          })),
          {
            behind: 0,
            syncRef: agent.syncRef ?? state.sourceRef,
            targetCommit: '',
          },
        ),
        maybeBoundRemoteProbe(agent, getAgentPendingWork(repoRoot, state.id, agent), null),
        readOutboxRecipients(repoRoot, agent.id).then((r) => r.length),
        maybeBoundRemoteProbe(
          agent,
          getAgentSessionState(agent).catch((): AgentSessionState => 'stopped'),
          'stopped' as AgentSessionState,
        ),
      ])

      const remoteTimedOut = syncStatus.timedOut || pending.timedOut || sessionState.timedOut
      const { behind, syncRef: resolvedSyncRef } = syncStatus.value
      const pendingValue = pending.value
      const sessionStateValue = sessionState.value
      const syncRef = resolvedSyncRef
      const behindStr = behind > 0 ? `  ${yellow(`${behind} behind ${syncRef}`)}` : ''
      const syncStr = syncRef !== state.sourceRef ? `  ${dim(`↟ ${syncRef}`)}` : ''
      const remoteTimeoutStr = remoteTimedOut ? `  ${yellow('remote timeout')}` : ''

      let locationStr = ''
      if (isSSH(agent.location)) {
        const session = tmuxSessionName(agent.id)
        const target = agent.location.host ?? `@${agent.location.alias ?? '?'} (unbound)`
        locationStr = `  ${cyan(`[ssh: ${target}]`)} ${dim(`tmux: ${session}`)}`
      }

      // The resolved engine (role + profile pin) is the truth of what a launch runs; fall back
      // to the stored snapshot only if resolution fails (e.g. a bad runtime in config).
      let config: string
      try {
        const sel = resolveRuntimeSelection({ agent, config: quimbyConfig })
        config = dim(`${sel.runtime} / ${sel.entrypoint}`)
      } catch {
        config = defaults
          ? dim(`${defaults.runtime ?? 'local'} / ${defaults.entrypoint ?? 'claude'}`)
          : dim('no defaults — run `quimby set`')
      }

      const outboxStr = outboxDrafts > 0 ? `  ${cyan(`queued: ${outboxDrafts}`)}` : ''

      let pendingStr = ''
      if (pendingValue !== null) {
        const parts: string[] = []
        if (pendingValue.commits > 0) parts.push(`${pendingValue.commits} ahead`)
        if (pendingValue.dirty) parts.push('dirty')
        if (parts.length > 0) pendingStr = `  ${green(`● ${parts.join(', ')}`)}`
      }

      // running = detached (headless, `quimby start`); attached = a client is in
      // `quimby run`; stopped = no session. A local non-tmux agent reads as stopped
      // (it has no session to probe even while a foreground `run` is live).
      const stateStr =
        sessionStateValue === 'attached'
          ? cyan('● attached')
          : sessionStateValue === 'running'
            ? green('● running')
            : dim('○ stopped')

      // The short id matches the tmux session (`qb-<id8>`) and sandbox names, so the
      // roster correlates with `tmux ls` / `sbx ls`.
      console.log(
        `  ${name}  ${stateStr}  ${dim(`id:${agent.id.slice(0, 8)}`)}  ${dim(`seed:${agent.seedCommit.slice(0, 8)}`)}  ${config}${locationStr}${syncStr}${outboxStr}${pendingStr}${behindStr}${remoteTimeoutStr}`,
      )
    }
  }

  const serverInfo = await getServerInfo(repoRoot)
  if (serverInfo) {
    console.log()
    console.log(dim(`Server running on :${serverInfo.port} (PID: ${serverInfo.pid})`))
  }
}

async function maybeBoundRemoteProbe<T>(
  agent: Readonly<Pick<AgentState, 'location'>>,
  probe: Promise<T>,
  fallback: T,
) {
  if (!isSSH(agent.location)) return { value: await probe, timedOut: false }
  return withRemoteProbeTimeout(probe, fallback)
}
