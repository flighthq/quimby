import { quimbyTmuxSocket } from '@quimbyhq/paths'
import { execa } from 'execa'

const TMUX = ['-L', quimbyTmuxSocket]

/** A tmux client on the quimby socket: which tty it draws on, and which session it displays. */
export interface TmuxClientInfo {
  tty: string
  session: string
  /** `#{client_activity}` — epoch seconds of this client's last input. */
  activity?: number
}

/** One pane, as `list-panes -a` reports it — enough to walk from a session to its focused pane. */
export interface TmuxPaneInfo {
  tty: string
  session: string
  windowId: string
  windowName: string
  windowActive: boolean
  paneActive: boolean
}

/** The windows a human is actually looking at right now. */
export interface FocusedWindows {
  /** `#{window_id}` values — stable across `link-window`, so a shared window matches either way. */
  ids: Set<string>
  /** `#{window_name}` values — how an SSH agent's dashboard window is matched (ids are per-server). */
  names: Set<string>
}

/**
 * The windows a human is actually looking at, read from the quimby tmux server.
 *
 * This is the precise form of "is someone typing here?" that a session-wide attached count cannot
 * express: a dashboard attaches a client per *pane*, so every agent in a layout reads as attached
 * while the human is in exactly one of them. Any probe failure yields an empty set — an unknown
 * focus must not manufacture a hold.
 */
export async function getFocusedTmuxWindows(): Promise<FocusedWindows> {
  try {
    const [clientsOut, panesOut] = await Promise.all([
      execa('tmux', [...TMUX, 'list-clients', '-F', CLIENT_FORMAT]),
      execa('tmux', [...TMUX, 'list-panes', '-a', '-F', PANE_FORMAT]),
    ])
    return resolveFocusedWindows(
      parseClients(clientsOut.stdout),
      parsePanes(panesOut.stdout),
      Math.floor(Date.now() / 1000),
    )
  } catch {
    return { ids: new Set(), names: new Set() }
  }
}

/** Whether any local quimby window carries this display name (an agent's own window, or a tab). */
export async function hasLocalWindowNamed(name: string): Promise<boolean> {
  try {
    const { stdout } = await execa('tmux', [...TMUX, 'list-panes', '-a', '-F', PANE_FORMAT])
    return parsePanes(stdout).some((p) => p.windowName === name)
  } catch {
    return false
  }
}

/**
 * Walk from every real (non-nested) client down to the window it ultimately displays.
 *
 * A quimby panel dashboard nests: the terminal's client displays the wrapper session, whose active
 * pane runs `tmux attach` to a view session, whose active window is the agent's (shared in by
 * `link-window`). So focus is a *chain*, and only its endpoint counts — the sibling panes hold
 * clients too, but nobody is typing in them. A client whose tty is some pane's tty is that nested
 * link; clients on a real terminal are the roots. With no nesting detectable, every client is a
 * root, which degrades to the plain "the session you attached" answer.
 */
export function resolveFocusedWindows(
  clients: readonly TmuxClientInfo[],
  panes: readonly TmuxPaneInfo[],
  nowSeconds?: number,
): FocusedWindows {
  // A client that hasn't taken input in minutes is a window left open, not a human mid-keystroke —
  // overnight, every pane looks "focused" forever. Treating those as focus would hold the nudge for
  // the one agent you most need woken until morning, and an unwoken agent is worse than a nudge
  // landing under an idle cursor. Clients that report no activity time are treated as active.
  const live = clients.filter(
    (c) =>
      nowSeconds === undefined ||
      c.activity === undefined ||
      nowSeconds - c.activity <= FOCUS_IDLE_GRACE_SECONDS,
  )
  clients = live.length > 0 ? live : []
  // A client is a root when nothing else is displaying it: either it draws on a real terminal (its
  // tty is no pane's tty), or the pane hosting it belongs to a session no client is attached to —
  // so the chain genuinely starts there. Checking the *host session* rather than just "is it a
  // pane" matters: the top-level client can itself live in a pane, and treating it as nested would
  // leave no roots at all, collapsing to "every attached session is focused".
  const sessionsWithClients = new Set(clients.map((c) => c.session))
  const paneByTty = new Map(panes.map((p) => [p.tty, p]))
  const roots = clients.filter((c) => {
    const host = paneByTty.get(c.tty)
    return !host || !sessionsWithClients.has(host.session)
  })
  const ids = new Set<string>()
  const names = new Set<string>()

  const queue = (roots.length > 0 ? roots : clients).map((c) => c.session)
  const visited = new Set<string>()
  while (queue.length > 0) {
    const session = queue.pop() as string
    if (visited.has(session)) continue
    visited.add(session)

    const focusedPane = panes.find((p) => p.session === session && p.windowActive && p.paneActive)
    if (!focusedPane) continue

    // The focused pane hosts a nested client ⇒ the chain continues into that client's session;
    // the pane itself is a viewport, not where the keystrokes land.
    const nested = clients.filter((c) => c.tty === focusedPane.tty)
    if (nested.length > 0) {
      queue.push(...nested.map((c) => c.session))
      continue
    }

    ids.add(focusedPane.windowId)
    names.add(focusedPane.windowName)
  }

  return { ids, names }
}

// How long a client may sit without input before its window stops counting as focused.
const FOCUS_IDLE_GRACE_SECONDS = 180

const SEPARATOR = '|'
const CLIENT_FORMAT = ['#{client_tty}', '#{client_activity}', '#{client_session}'].join(SEPARATOR)
const PANE_FORMAT = [
  '#{pane_tty}',
  '#{session_name}',
  '#{window_id}',
  '#{window_active}',
  '#{pane_active}',
  '#{window_name}',
].join(SEPARATOR)

function parseClients(stdout: string): TmuxClientInfo[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [tty, activity, ...rest] = line.split(SEPARATOR)
      const session = rest.join(SEPARATOR)
      if (!tty || !session) return []
      const seconds = Number(activity)
      return [{ tty, session, ...(Number.isFinite(seconds) ? { activity: seconds } : {}) }]
    })
}

// The window name is last and joined back, since it is the one field that may contain the
// separator (an agent may be named anything); every field before it is tmux-generated.
function parsePanes(stdout: string): TmuxPaneInfo[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [tty, session, windowId, windowActive, paneActive, ...rest] = line.split(SEPARATOR)
      if (!tty || !session || !windowId) return []
      return [
        {
          tty,
          session,
          windowId,
          windowName: rest.join(SEPARATOR),
          windowActive: windowActive === '1',
          paneActive: paneActive === '1',
        },
      ]
    })
}
