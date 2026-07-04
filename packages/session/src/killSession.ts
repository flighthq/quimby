import { quimbyTmuxSocket, tmuxSessionName } from '@quimbyhq/paths'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { execa } from 'execa'

/**
 * Kill an agent's quimby tmux session (local or remote), tolerating "no such session" so a
 * stopped agent tears down cleanly. A local agent that was never run has no session to kill.
 * Used by `stop`, `remove`, and `rebuild` to end a live agent before its repo/sandbox is torn
 * down — otherwise the process would linger against a directory that is about to change.
 */
export async function killAgentSession(agent: Readonly<AgentState>): Promise<void> {
  if (!isSSH(agent.location) && !agent.tmux) return
  const session = tmuxSessionName(agent.id)
  try {
    if (isSSH(agent.location)) {
      await getSSHTransport(agent.location).exec(
        `tmux -L ${quimbyTmuxSocket} kill-session -t ${sq(session)}`,
      )
    } else {
      await execa('tmux', ['-L', quimbyTmuxSocket, 'kill-session', '-t', session])
    }
  } catch {
    // No live session (already stopped) — nothing to tear down.
  }
}
