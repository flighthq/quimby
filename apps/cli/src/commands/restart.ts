import { QuimbyError } from '@quimbyhq/errors'
import { agentTmuxSocket, tmuxSessionName } from '@quimbyhq/paths'
import { getAgentSessionState } from '@quimbyhq/session'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

import { assertAgentEnabled } from '../enabled'
import { ensureAgentConnections } from '../hostAlias'
import { runStartCommand } from './start'

export default defineCommand({
  meta: {
    name: 'restart',
    description:
      "Recreate an agent's tmux session with its current launch config (keeps its work/mailbox)",
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent name(s)',
      required: false,
    },
    all: {
      type: 'boolean',
      description: 'Restart every currently-running agent',
      default: false,
    },
  },
  run: runRestartCommand,
})

export async function runRestartCommand({
  args,
}: {
  args: { agent?: string; _?: string[]; all?: boolean }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  const explicit = [
    ...new Set([args.agent, ...(args._ ?? [])].filter((n): n is string => Boolean(n))),
  ]
  if (!args.all && explicit.length === 0) {
    throw new QuimbyError('Provide an agent name, or --all to restart every running agent.')
  }
  for (const name of explicit) {
    if (!state.agents[name]) throw new QuimbyError(`Agent "${name}" not found`)
    // Checked before anything is killed: a named disabled agent must not lose its session to a
    // restart that then refuses to relaunch it.
    assertAgentEnabled(state.agents[name], name)
  }

  // --all targets only running agents (refresh the live fleet); a named agent is (re)launched
  // regardless, so it ends up running with current config either way.
  const names = args.all
    ? (
        await Promise.all(
          Object.keys(state.agents).map(async (name) =>
            (await getAgentSessionState(state.agents[name])) !== 'stopped' &&
            state.agents[name].enabled !== false
              ? name
              : null,
          ),
        )
      ).filter((n): n is string => n !== null)
    : explicit

  // A disabled agent holding a live session is not restarted — but it is named, because a sweep
  // that silently passes over a running agent is indistinguishable from one that missed it.
  if (args.all) {
    for (const [name, agent] of Object.entries(state.agents)) {
      if (agent.enabled !== false) continue
      if ((await getAgentSessionState(agent)) === 'stopped') continue
      logger.warn(
        `Skipped "${name}" — it is disabled but still holds a session. ` +
          `\`quimby stop ${name}\` to free it, or \`quimby enable ${name}\` to bring it back.`,
      )
    }
  }

  if (names.length === 0) {
    logger.info('No running agents to restart.')
    return
  }

  // Resolve SSH host aliases up front so killing a remote session has a concrete host.
  await ensureAgentConnections(repoRoot, state, names)

  for (const name of names) {
    const agent = state.agents[name]
    const session = tmuxSessionName(agent.id)
    if ((await getAgentSessionState(agent)) !== 'stopped') {
      if (isSSH(agent.location)) {
        await getSSHTransport(agent.location)
          .exec(`tmux -L ${agentTmuxSocket(agent)} kill-session -t ${sq(session)}`)
          .catch(() => {})
      } else {
        await execa('tmux', ['-L', agentTmuxSocket(agent), 'kill-session', '-t', session]).catch(
          () => {},
        )
      }
      logger.info(`Killed "${name}" session; relaunching with current config…`)
    }
    // `start` does the fresh launch with role-resolved config and records the new fingerprint.
    await runStartCommand({ args: { agent: name } })
  }
}
