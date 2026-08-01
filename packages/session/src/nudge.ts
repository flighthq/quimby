import { setTimeout as delay } from 'node:timers/promises'

import {
  dashboardSessionName,
  dashboardViewPrefix,
  quimbyTmuxSocket,
  tmuxSessionName,
} from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentState, ResolvedFocusPolicy } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { execa } from 'execa'

import { getFocusedTmuxWindows, hasLocalWindowNamed } from './focus'
import { getAgentSessionState } from './sessionState'

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

// Every local tmux call is a control-socket round trip that returns in milliseconds — except when
// it doesn't. `send-keys` into a pane whose mode opens a prompt blocks until a human answers it
// (see cancelPaneMode), and an execa with no timeout turns that into an unbounded await: the
// server's poll cycle is one long chain, so one wedged tmux call stalled a whole fleet's cycle for
// 20+ minutes ("Poll cycle still running after 5s — skipped 228 tick(s)"). Cancelling the mode
// first removes the cause; this bounds every other way tmux can fail to answer.
const TMUX_EXEC_TIMEOUT_MS = 5000

// A courier-injected message leads with this so the agent can tell it from text the user typed
// live: `quimby · <label>` (e.g. `parcel review-abc123 from review`, `assignment updated`,
// `resume …`). The
// interpunct is the only separator; where to read (inbox / assignment / status) is taught once in
// the agent's AGENTS.md rather than repeated on every line. Absence of the lead means the user is
// typing directly — the agent's top authority.
export const COURIER_PREFIX = 'quimby · '

/**
 * What a nudge attempt actually did.
 *
 * `held` is the one that matters to callers: the parcel is delivered but the wake was deferred by
 * §7, so a retry later can still land. Without this distinction a caller cannot tell "the agent was
 * told and ignored it" from "the agent was never told", and the reminder sweep counted both against
 * its give-up cap — so sustained focus silently exhausted the retries and reported a perfectly
 * healthy agent as stuck.
 */
export type NudgeOutcome = 'sent' | 'held' | 'skipped' | 'no-session'

/**
 * Whether an automated nudge should stand down rather than type into this agent (§7).
 *
 * The rule is deliberately about *focus*, not attachment. A dashboard attaches a client to every
 * pane it shows — and for an SSH agent that client is a real `ssh … tmux attach` to the agent's own
 * session — so "is a client attached?" reads true for an entire layout while the human is typing in
 * exactly one pane. That held every nudge for every agent in a dashboard, which is the whole
 * problem §7 was meant to be a narrow exception to.
 *
 * So a hold requires the session to be attached *and* the agent's window to be the endpoint of the
 * human's focus chain. Matching is by `window_id` (stable
 * across `link-window`, so a local agent's shared window matches whether it is reached through its
 * own session or a dashboard tab) and by window name (an SSH agent's window lives on another tmux
 * server, where ids are meaningless, and its dashboard window is created with the agent's name).
 * One conservative fallback: an SSH agent whose remote session is attached with no local quimby
 * window carrying its name is a bare `quimby run <agent>` in a plain terminal — no local focus
 * information exists, so it holds.
 *
 * This is deliberately NOT the `nudge` policy: that decides which parcels are worth waking you for,
 * a question settled before we get here. This guard only refuses to type over live keystrokes, so
 * it holds one window and releases the moment you look elsewhere. `quimby nudge` forces past it.
 *
 * `whenFocused` is the recipient's own answer to *this* question — `hold` stands down, `nudge`
 * types anyway. The caller resolves it (config and the authority graph both live above this
 * package), including collapsing the `directed` default, so a fleet you watch but do not converse
 * with never stalls on being looked at. `graceSeconds` is the watching-vs-typing window.
 */
export async function shouldHoldNudge(
  agent: Readonly<AgentState>,
  displayName: string,
  opts: Readonly<{
    whenFocused?: ResolvedFocusPolicy
    graceSeconds?: number
    /** This workspace's project id, to scope name matching to its own dashboard sessions. */
    projectId?: string
  }> = {},
): Promise<boolean> {
  if (opts.whenFocused === 'nudge') return false
  if ((await getAgentSessionState(agent)) !== 'attached') return false

  const focused = await getFocusedTmuxWindows(opts.graceSeconds)
  const mine = ownsSession(opts.projectId)

  if (isSSH(agent.location)) {
    // A remote window id is meaningless on the local server, so an SSH agent can only be matched by
    // NAME — scoped to this project's own dashboard, since names repeat across workspaces.
    if (focused.windows.some((w) => w.windowName === displayName && mine(w.session))) return true
    return !(await hasLocalWindowNamed(displayName, mine))
  }

  // A local agent's window id is unique on the shared socket (and stable across `link-window`, so
  // it matches from its own session or a dashboard tab). That makes it the whole answer — matching
  // the display NAME as well only added cross-workspace false positives.
  const windowId = await getAgentWindowId(tmuxSessionName(agent.id))
  return windowId !== null && focused.ids.has(windowId)
}

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
  /** Raw text typed verbatim — a bare poke ("continue") or an explicit `nudge --raw -m`. */
  text?: string
  /**
   * A courier label. When set, the message typed is `quimby · <courier>` rather than `text`, and
   * the `quimby · ` lead marks it as delivered by the courier (a parcel, an assignment change, a
   * resume) — the one signal the agent uses to tell an agent/system directive from the user typing
   * live. Rendered here so no caller can inject a courier message unmarked.
   */
  courier?: string
  dashboardSession?: string
  /**
   * Bypass the §7 attached-session skip. Automated nudges (assign/handoff/dispatch) leave this
   * unset so they never inject over a human in `quimby run`; the explicit `quimby nudge` sets it,
   * since that is the human deliberately typing into the session.
   */
  force?: boolean
  /** This workspace's project id, so the §7 guard scopes name matching to its own dashboard. */
  projectId?: string
  /**
   * The recipient's resolved `whenFocused` policy — `hold` (default) defers when this is the pane
   * the human is working in, `nudge` types anyway. Resolved by the caller from config + the
   * authority graph (`resolveAgentFocusPolicy`), since this package sits below
   * `@quimbyhq/workspace` and must not read either.
   */
  whenFocused?: ResolvedFocusPolicy
  /** Seconds since a keystroke that still count as "working in this pane" (`focusGrace`). */
  focusGraceSeconds?: number
  /**
   * Suppress the held-nudge notice and status-line flash. Set by a caller that RETRIES a held
   * nudge: the hold is announced once, not once per poll cycle, or a watched pane would flash and
   * the server log would repeat every few seconds for as long as someone is typing.
   */
  quietHold?: boolean
  reporter?: Reporter
}): Promise<NudgeOutcome> {
  const { agent, clear, displayName, dashboardSession } = opts
  const reporter = opts.reporter ?? silentReporter
  const message = opts.courier !== undefined ? `${COURIER_PREFIX}${opts.courier}` : opts.text
  if (message === undefined) {
    throw new Error('nudgeAgentSession requires either `text` or `courier`')
  }

  if (!isSSH(agent.location) && !agent.tmux) {
    // Local non-tmux agent — try dashboard window before giving up.
    if (
      dashboardSession &&
      (await nudgeWindowInSession(dashboardSession, displayName, message, reporter))
    ) {
      return 'sent'
    }
    reporter.info(
      `"${displayName}" isn't a tmux/SSH agent — it'll see it on its next run ` +
        `(enable tmux via \`quimby config ${displayName}\` for live nudges).`,
    )
    return 'skipped'
  }

  const session = tmuxSessionName(agent.id)

  // §7 (coordination-proposals): never inject into a session a human is typing in — it types over
  // their input, and the work is already durable in the inbox/assignment, so a deferred nudge loses
  // nothing (the human sees it on their next turn). The explicit `quimby nudge` sets `force`.
  if (
    !opts.force &&
    (await shouldHoldNudge(agent, displayName, {
      whenFocused: opts.whenFocused,
      graceSeconds: opts.focusGraceSeconds,
      projectId: opts.projectId,
    }))
  ) {
    // Flash the status line of the session being held. A held nudge is otherwise invisible to the
    // one person it is held FOR — they are working in that pane while the only notice goes to the
    // server log somewhere else. `display-message` reaches the status bar without touching the
    // pane's stdin, which is the whole point: injecting the text instead (even without Return)
    // would land in a half-typed prompt and corrupt it.
    if (!opts.quietHold) {
      await flashHeldNudge(agent, session, message)
      reporter.info(
        `Held nudge for "${displayName}" — you're working in it; it'll be retried once you look ` +
          `away (\`quimby nudge ${displayName}\` forces it now, or set \`whenFocused: nudge\` ` +
          'to never hold for this agent).',
      )
    }
    return 'held'
  }

  try {
    if (isSSH(agent.location)) {
      const transport = getSSHTransport(agent.location)
      await transport.exec(buildRemoteNudgeCommand(session, message, Boolean(clear)))
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
        return 'skipped'
      }
      await execa('tmux', [...TMUX, 'has-session', '-t', session], {
        timeout: TMUX_EXEC_TIMEOUT_MS,
      })
      await cancelPaneMode(session)
      if (clear) {
        await sendKeysLocal(session, CLEAR_COMMAND)
        await delay(CLEAR_SETTLE_MS)
      }
      await sendKeysLocal(session, message)
    }
    const cleared = clear ? ' (cleared context first)' : ''
    reporter.success(`Nudged "${displayName}" in tmux session "${session}"${cleared}`)
    return 'sent'
  } catch {
    // Per-agent session not found — try dashboard window before reporting.
  }

  if (
    dashboardSession &&
    (await nudgeWindowInSession(dashboardSession, displayName, message, reporter))
  ) {
    return 'sent'
  }

  reporter.warn(
    `"${displayName}" isn't running in tmux session "${session}" — not nudged ` +
      `(it'll see it on its next run; bring it up headless with \`quimby start ${displayName}\`).`,
  )
  return 'no-session'
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
    await cancelPaneMode(target)
    await execa('tmux', [...TMUX, 'send-keys', '-t', target, '-l', text], {
      timeout: TMUX_EXEC_TIMEOUT_MS,
    })
    await delay(SUBMIT_SETTLE_MS)
    await execa('tmux', [...TMUX, 'send-keys', '-t', target, 'Enter'], {
      timeout: TMUX_EXEC_TIMEOUT_MS,
    })
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
  // The cancel is `;`-joined, not `&&`: it exits non-zero on the common case (the pane is not in a
  // mode), which would otherwise swallow the nudge it exists to protect.
  return `${TMUX_CMD} has-session -t ${sq(session)} 2>/dev/null && { ${remoteCancelPaneMode(session)}; ${inject}; }`
}

// Two send-keys as a shell fragment (for SSH transport): `-l` types the literal text
// (no key-name parsing), then a separate Enter submits it to the agent's prompt.
function sendKeysInject(session: string, text: string): string {
  return `${TMUX_CMD} send-keys -t ${sq(session)} -l ${sq(text)} && sleep ${SUBMIT_SETTLE_MS / 1000} && ${TMUX_CMD} send-keys -t ${sq(session)} Enter`
}

// The local twin of `sendKeysInject`: type the literal text, then submit with Enter.
async function sendKeysLocal(session: string, text: string): Promise<void> {
  await execa('tmux', [...TMUX, 'send-keys', '-t', session, '-l', text], {
    timeout: TMUX_EXEC_TIMEOUT_MS,
  })
  await delay(SUBMIT_SETTLE_MS)
  await execa('tmux', [...TMUX, 'send-keys', '-t', session, 'Enter'], {
    timeout: TMUX_EXEC_TIMEOUT_MS,
  })
}

/**
 * Leave copy mode (or any pane mode) on the target before typing into it.
 *
 * Quimby's bundled tmux config sets `mouse on`, so a wheel scroll — the obvious way to read what an
 * agent just did — puts that pane in copy mode. A pane in a mode routes `send-keys -l` through the
 * **copy-mode key table** instead of to the program, so the nudge is consumed as editor commands
 * rather than delivered: `q` cancels, `t`/`f` open the "Jump to forward:" prompt, `/` opens search.
 * Two failures follow, and the second is the expensive one. The agent is never woken (and the human
 * finds a stray jump prompt in the pane), and the send-keys **client blocks until a human answers
 * that prompt** — verified on tmux 3.6, where `send-keys -l 'continue'` into a copy-mode pane with a
 * client attached never returns. That await is inside the server's poll cycle, which is why one
 * scrolled-up pane stalled a cycle for 20+ minutes and every other agent's dispatch behind it.
 *
 * `-X cancel` errors with "not in a mode" in the common case, so its failure is ignored. The cost is
 * that a nudge scrolls a watched pane back to the bottom; the §7 focus guard already holds nudges
 * for the pane you are *typing* in, and losing the wake outright is strictly worse.
 */
async function cancelPaneMode(target: string): Promise<void> {
  try {
    await execa('tmux', [...TMUX, 'send-keys', '-t', target, '-X', 'cancel'], {
      timeout: TMUX_EXEC_TIMEOUT_MS,
    })
  } catch {
    // Not in a mode (the common case), or the target vanished — the injection below reports that.
  }
}

/** The remote twin of `cancelPaneMode`, as a shell fragment for the SSH one-shot command. */
function remoteCancelPaneMode(session: string): string {
  return `${TMUX_CMD} send-keys -t ${sq(session)} -X cancel 2>/dev/null || true`
}

/**
 * Whether `session`'s active pane is the pane this process is running in. Only possible when we
 * are invoked from *inside* the quimby tmux server (e.g. a host shell in the dashboard) — so it
 * gates on `$TMUX` pointing at that same server before comparing pane ids (which are per-server,
 * hence meaningless to compare across servers). Guards against a nudge typing into the user's
 * own shell, where the text would run as a command. Any probe failure is treated as "not us".
 */
// Announce a held nudge on the status line of the session it was held for — best-effort and
// never fatal, since it is a courtesy on top of a delivery that already succeeded.
async function flashHeldNudge(
  agent: Readonly<AgentState>,
  session: string,
  message: string,
): Promise<void> {
  const text = `${message}  (held while you type — press Enter when ready)`
  // `-N` makes the message ignore key presses. Without it tmux clears a status message on the
  // client's *next key*, and this flash fires precisely because the user is mid-keystroke — so
  // their very next character wiped it, however long a delay we asked for. How long it then sits
  // is `display-time`, set in quimby's bundled tmux config and overridable from the user's own
  // ~/.tmux.conf, rather than a constant only a recompile could change.
  const flash = async (ignoreKeys: boolean): Promise<void> => {
    if (isSSH(agent.location)) {
      await getSSHTransport(agent.location).exec(
        `${TMUX_CMD} display-message ${ignoreKeys ? '-N ' : ''}-t ${sq(session)} ${sq(text)}`,
      )
      return
    }
    const flags = ignoreKeys ? ['-N'] : []
    await execa('tmux', [...TMUX, 'display-message', ...flags, '-t', session, text])
  }
  try {
    await flash(true)
  } catch {
    try {
      // tmux predating `-N` rejects the flag outright; a brief flash beats none.
      await flash(false)
    } catch {
      // No session, no client, or an unreachable host — the inbox still holds the work.
    }
  }
}

// The window id of a local session's active window. An agent session holds exactly one window, and
// `link-window` shares that same window object into a dashboard, so this id identifies the agent's
// window from either side. Null when the session or the tmux server is gone.
async function getAgentWindowId(session: string): Promise<string | null> {
  try {
    const { stdout } = await execa('tmux', [
      ...TMUX,
      'display-message',
      '-p',
      '-t',
      session,
      '#{window_id}',
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}

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

// Whether a session belongs to this workspace, for scoping a window-NAME match. Only the session
// name carries a project id (`qb-dash-<projectId>`, `qbv-<projectId>-<n>`); an agent's own session
// is keyed by agent UUID and a window name is just a display label, so without this a same-named
// agent in another workspace on the shared socket answers for this one. With no project id known,
// nothing is claimed — an unscoped guess is what caused the false holds.
function ownsSession(projectId: string | undefined): (session: string) => boolean {
  if (!projectId) return () => false
  const dashboard = dashboardSessionName(projectId)
  const viewPrefix = dashboardViewPrefix(projectId)
  return (session) => session === dashboard || session.startsWith(viewPrefix)
}
