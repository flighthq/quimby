import { agentTmuxSocket, tmuxSessionName } from '@quimbyhq/paths'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentSessionState, AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { execa } from 'execa'

// Every quimby tmux command targets the dedicated `-L quimby` server, or it would look
// at the user's default server and never find the agent sessions.

const tmuxCmd = (agent: Readonly<AgentState>) => `tmux -L ${agentTmuxSocket(agent)}`

/**
 * Report an agent's live tmux session state: `attached` (a client is in `quimby run`),
 * `running` (a detached headless session from `quimby start`), or `stopped` (no session).
 *
 * The probe is tmux's own `#{session_attached}` count, so it is the source of truth
 * regardless of the agent's `tmux` config flag — a local agent started headless has a
 * session even though it never opted into tmux for `run`. Any failure (no session,
 * unreachable SSH host, missing tmux) reads as `stopped`.
 *
 * `has-session` gates the count read because `display-message` on an unknown target
 * silently falls back (empty output, exit 0) when the quimby tmux server is up for
 * other agents — so without the gate a stopped agent would misread as attached.
 */
export async function getAgentSessionState(
  agent: Readonly<AgentState>,
): Promise<AgentSessionState> {
  const session = tmuxSessionName(agent.id)
  try {
    let attached: string
    if (isSSH(agent.location)) {
      attached = (
        await getSSHTransport(agent.location).exec(
          `${tmuxCmd(agent)} has-session -t ${sq(session)} && ${tmuxCmd(agent)} display-message -p -t ${sq(session)} '#{session_attached}'`,
        )
      ).trim()
    } else {
      await execa('tmux', ['-L', agentTmuxSocket(agent), 'has-session', '-t', session])
      attached = (
        await execa('tmux', [
          '-L',
          agentTmuxSocket(agent),
          'display-message',
          '-p',
          '-t',
          session,
          '#{session_attached}',
        ])
      ).stdout.trim()
    }
    return attached === '0' ? 'running' : 'attached'
  } catch {
    return 'stopped'
  }
}
