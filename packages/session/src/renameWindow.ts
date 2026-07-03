import { quimbyTmuxSocket, tmuxSessionName } from '@quimbyhq/paths'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { execa } from 'execa'

// Every quimby tmux command targets the dedicated `-L quimby` server, or it would look
// at the user's default server and never find the agent sessions.
const TMUX = ['-L', quimbyTmuxSocket]
const TMUX_CMD = `tmux ${TMUX.join(' ')}`

/**
 * Relabel the agent's live tmux window to `windowName` so a rename shows up immediately in
 * a running or attached session — and, because a dashboard tab shares the same linked window,
 * in that tab too — instead of only refreshing on the next `quimby run`.
 *
 * The agent session is single-window, so targeting the session hits its window. Returns
 * whether a live window was relabeled: a local non-tmux agent (no session) and any agent
 * whose session isn't running both no-op to `false`, so the caller can word its output.
 */
export async function renameAgentWindow(
  agent: Readonly<AgentState>,
  windowName: string,
): Promise<boolean> {
  if (!isSSH(agent.location) && !agent.tmux) return false
  const session = tmuxSessionName(agent.id)
  try {
    if (isSSH(agent.location)) {
      // has-session first so a stopped agent throws here and no-ops to false, rather than the
      // rename erroring on a missing target.
      const transport = getSSHTransport(agent.location)
      await transport.exec(`${TMUX_CMD} has-session -t ${sq(session)}`)
      await transport.exec(`${TMUX_CMD} rename-window -t ${sq(session)} ${sq(windowName)}`)
      return true
    }
    await execa('tmux', [...TMUX, 'has-session', '-t', session])
    await execa('tmux', [...TMUX, 'rename-window', '-t', session, windowName])
    return true
  } catch {
    return false
  }
}
