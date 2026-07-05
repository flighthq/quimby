import { setTimeout as delay } from 'node:timers/promises'

import { quimbyTmuxSocket, tmuxSessionName } from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { execa } from 'execa'

// Every quimby tmux command targets the dedicated `-L quimby` server, or it would look
// at the user's default server and never find the agent sessions.
const TMUX = ['-L', quimbyTmuxSocket]
const TMUX_CMD = `tmux ${TMUX.join(' ')}`

// The CLI control command that resets an agent's context; sent before the nudge text
// when `clear` is set, so the agent picks up the work on a fresh context.
const CLEAR_COMMAND = '/clear'

// A slash command needs a beat to be accepted and processed before the next line is
// typed, or the nudge text races into the still-open `/clear` prompt.
const CLEAR_SETTLE_MS = 600

// Some agent TUIs need a short beat after literal text arrives before Enter is read as
// submission rather than just another line-editing event.
const SUBMIT_SETTLE_MS = 150

/**
 * Whether the agent has a live tmux session right now (`tmux has-session`). False for
 * a local non-tmux agent (no session to have) and for any tmux/SSH agent that isn't
 * currently running. Lets `nudge --all` target only sessions that actually exist.
 *
 * When `dashboardSession` is provided, also checks for the agent as a window in
 * that session (multi-agent `quimby run` creates one session with agent windows).
 */
export async function hasAgentSession(
  agent: Readonly<AgentState>,
  opts?: { dashboardSession?: string },
): Promise<boolean> {
  if (!isSSH(agent.location) && !agent.tmux) {
    // Local non-tmux agent — but might still be in a dashboard window.
    if (opts?.dashboardSession) {
      return hasWindowInSession(opts.dashboardSession, agent.name)
    }
    return false
  }
  const session = tmuxSessionName(agent.id)
  try {
    if (isSSH(agent.location)) {
      await getSSHTransport(agent.location).exec(`${TMUX_CMD} has-session -t ${sq(session)}`)
    } else {
      await execa('tmux', [...TMUX, 'has-session', '-t', session])
    }
    return true
  } catch {
    if (opts?.dashboardSession) {
      return hasWindowInSession(opts.dashboardSession, agent.name)
    }
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
 *
 * With `clear`, a `/clear` control command is typed first (and given a beat to settle)
 * so the agent resets its context before picking up the nudge text.
 *
 * When `dashboardSession` is provided and the per-agent session isn't found, falls
 * back to targeting the agent's window in the dashboard session.
 */
export async function nudgeAgentSession(opts: {
  agent: Readonly<AgentState>
  clear?: boolean
  displayName: string
  text: string
  dashboardSession?: string
  reporter?: Reporter
}): Promise<void> {
  const { agent, clear, displayName, text, dashboardSession } = opts
  const reporter = opts.reporter ?? silentReporter

  if (!isSSH(agent.location) && !agent.tmux) {
    // Local non-tmux agent — try dashboard window before giving up.
    if (
      dashboardSession &&
      (await nudgeWindowInSession(dashboardSession, displayName, text, reporter))
    ) {
      return
    }
    reporter.info(
      `"${displayName}" isn't a tmux/SSH agent — it'll see it on its next run ` +
        `(enable tmux via \`quimby config ${displayName}\` for live nudges).`,
    )
    return
  }

  const session = tmuxSessionName(agent.id)

  try {
    if (isSSH(agent.location)) {
      const transport = getSSHTransport(agent.location)
      await transport.exec(buildRemoteNudgeCommand(session, text, Boolean(clear)))
    } else {
      // Guard the dashboard hazard: if this command is itself running inside the quimby tmux
      // server and the target session's active pane is the very pane we're in, send-keys would
      // type the nudge into the user's own shell (where it gets executed as a command). Skip it.
      if (await isTargetOurOwnPane(session)) {
        reporter.warn(
          `Skipped nudging "${displayName}" — its session's active pane is the one you're in ` +
            `(you're inside the quimby dashboard). The work is delivered; nudge from outside the ` +
            `dashboard, or open "${displayName}"'s tab so it isn't the focused pane.`,
        )
        return
      }
      await execa('tmux', [...TMUX, 'has-session', '-t', session])
      if (clear) {
        await sendKeysLocal(session, CLEAR_COMMAND)
        await delay(CLEAR_SETTLE_MS)
      }
      await sendKeysLocal(session, text)
    }
    const cleared = clear ? ' (cleared context first)' : ''
    reporter.success(`Nudged "${displayName}" in tmux session "${session}"${cleared}`)
    return
  } catch {
    // Per-agent session not found — try dashboard window before reporting.
  }

  if (
    dashboardSession &&
    (await nudgeWindowInSession(dashboardSession, displayName, text, reporter))
  ) {
    return
  }

  reporter.warn(
    `"${displayName}" isn't running in tmux session "${session}" — not nudged ` +
      `(it'll see it on its next run; bring it up headless with \`quimby start ${displayName}\`).`,
  )
}

async function hasWindowInSession(session: string, windowName: string): Promise<boolean> {
  try {
    await execa('tmux', [...TMUX, 'has-session', '-t', session])
    const { stdout } = await execa('tmux', [
      ...TMUX,
      'list-windows',
      '-t',
      session,
      '-F',
      '#{window_name}',
    ])
    return stdout.split('\n').includes(windowName)
  } catch {
    return false
  }
}

async function nudgeWindowInSession(
  session: string,
  windowName: string,
  text: string,
  reporter: Reporter,
): Promise<boolean> {
  const target = `${session}:=${windowName}`
  try {
    await execa('tmux', [...TMUX, 'send-keys', '-t', target, '-l', text])
    await delay(SUBMIT_SETTLE_MS)
    await execa('tmux', [...TMUX, 'send-keys', '-t', target, 'Enter'])
    reporter.success(`Nudged "${windowName}" in dashboard "${session}"`)
    return true
  } catch {
    return false
  }
}

/**
 * The one-shot remote shell command that nudges an SSH agent: guard on the session
 * existing (so a stopped agent is a silent no-op), optionally type `/clear` + a settle
 * beat first, then type the literal text and submit it. Pure string building — all the
 * escaping (`sq`) and the clear/nudge sequencing live here, testable without a host.
 */
export function buildRemoteNudgeCommand(session: string, text: string, clear: boolean): string {
  // `sleep` between the two lines gives `/clear` time to process before the nudge.
  const clearInject = clear
    ? `${sendKeysInject(session, CLEAR_COMMAND)} && sleep ${CLEAR_SETTLE_MS / 1000} && `
    : ''
  const inject = `${clearInject}${sendKeysInject(session, text)}`
  return `${TMUX_CMD} has-session -t ${sq(session)} 2>/dev/null && ${inject}`
}

// Two send-keys as a shell fragment (for SSH transport): `-l` types the literal text
// (no key-name parsing), then a separate Enter submits it to the agent's prompt.
function sendKeysInject(session: string, text: string): string {
  return `${TMUX_CMD} send-keys -t ${sq(session)} -l ${sq(text)} && sleep ${SUBMIT_SETTLE_MS / 1000} && ${TMUX_CMD} send-keys -t ${sq(session)} Enter`
}

// The local twin of `sendKeysInject`: type the literal text, then submit with Enter.
async function sendKeysLocal(session: string, text: string): Promise<void> {
  await execa('tmux', [...TMUX, 'send-keys', '-t', session, '-l', text])
  await delay(SUBMIT_SETTLE_MS)
  await execa('tmux', [...TMUX, 'send-keys', '-t', session, 'Enter'])
}

/**
 * Whether `session`'s active pane is the pane this process is running in. Only possible when we
 * are invoked from *inside* the quimby tmux server (e.g. a host shell in the dashboard) — so it
 * gates on `$TMUX` pointing at that same server before comparing pane ids (which are per-server,
 * hence meaningless to compare across servers). Guards against a nudge typing into the user's
 * own shell, where the text would run as a command. Any probe failure is treated as "not us".
 */
async function isTargetOurOwnPane(session: string): Promise<boolean> {
  const tmuxEnv = process.env.TMUX
  if (!tmuxEnv) return false
  const socketPath = tmuxEnv.split(',')[0]
  if (!socketPath.endsWith(`/${quimbyTmuxSocket}`)) return false
  try {
    const [here, target] = await Promise.all([
      execa('tmux', ['display-message', '-p', '#{pane_id}']),
      execa('tmux', [...TMUX, 'display-message', '-p', '-t', session, '#{pane_id}']),
    ])
    const herePane = here.stdout.trim()
    return herePane !== '' && herePane === target.stdout.trim()
  } catch {
    return false
  }
}
