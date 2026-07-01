import { quimbyTmuxSocket, tmuxSessionName } from '@quimbyhq/paths'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { execa } from 'execa'

// Every quimby tmux command targets the dedicated `-L quimby` server, or it would look
// at the user's default server and never find the agent sessions.
const TMUX = ['-L', quimbyTmuxSocket]
const TMUX_CMD = `tmux ${TMUX.join(' ')}`

/**
 * Whether the agent has a live tmux session right now (`tmux has-session`). False for
 * a local non-tmux agent (no session to have) and for any tmux/SSH agent that isn't
 * currently running. Lets `nudge --all` target only sessions that actually exist.
 */
export async function hasAgentSession(agent: Readonly<AgentState>): Promise<boolean> {
  if (!isSSH(agent.location) && !agent.tmux) return false
  const session = tmuxSessionName(agent.id)
  try {
    if (isSSH(agent.location)) {
      await getSSHTransport(agent.location).exec(`${TMUX_CMD} has-session -t ${sq(session)}`)
    } else {
      await execa('tmux', [...TMUX, 'has-session', '-t', session])
    }
    return true
  } catch {
    return false
  }
}

/**
 * Wake a live agent by typing `text` and Return into its tmux session, so a running
 * interactive agent picks up new work (an assignment, a delivered parcel) without the
 * user switching to its terminal. The session is identified by the agent's stable
 * UUID, so a rename never loses it.
 *
 * Only SSH agents and local agents opted into `tmux` have a detached session; a local
 * non-tmux agent runs in the foreground (the user is already attached to it), so there
 * is nothing to wake. When the session isn't running, this reports and no-ops — the
 * work was already written/delivered, so the agent will see it on its next run.
 */
export async function nudgeAgentSession(opts: {
  agent: Readonly<AgentState>
  displayName: string
  text: string
}): Promise<void> {
  const { agent, displayName, text } = opts

  if (!isSSH(agent.location) && !agent.tmux) {
    logger.info(
      `"${displayName}" isn't a tmux/SSH agent — it'll see it on its next run ` +
        `(enable tmux via \`quimby config ${displayName}\` for live nudges).`,
    )
    return
  }

  const session = tmuxSessionName(agent.id)
  // Two send-keys: `-l` types the literal text (no key-name parsing), then a
  // separate Enter submits it to the agent's prompt.
  const inject = `${TMUX_CMD} send-keys -t ${sq(session)} -l ${sq(text)} && ${TMUX_CMD} send-keys -t ${sq(session)} Enter`

  try {
    if (isSSH(agent.location)) {
      const transport = getSSHTransport(agent.location)
      await transport.exec(`${TMUX_CMD} has-session -t ${sq(session)} 2>/dev/null && ${inject}`)
    } else {
      await execa('tmux', [...TMUX, 'has-session', '-t', session])
      await execa('tmux', [...TMUX, 'send-keys', '-t', session, '-l', text])
      await execa('tmux', [...TMUX, 'send-keys', '-t', session, 'Enter'])
    }
    logger.success(`Nudged "${displayName}" in tmux session "${session}"`)
  } catch {
    logger.warn(
      `"${displayName}" isn't running in tmux session "${session}" — not nudged ` +
        `(it'll see it on its next run; start it with \`quimby run ${displayName}\`).`,
    )
  }
}
