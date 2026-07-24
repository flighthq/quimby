import { quimbyTmuxSocket } from '@quimbyhq/paths'
import { execa } from 'execa'

/** One live session on quimby's dedicated tmux server, as reported by `list-sessions`. */
export interface TmuxSessionSummary {
  name: string
  attached: boolean
  windows: number
  /** Epoch milliseconds the session was created. */
  createdAt: number
  /** Epoch milliseconds of the last activity in the session (tmux's `session_activity`). */
  activityAt: number
}

/**
 * Kill one session on quimby's tmux server by name, reporting whether it was there to kill.
 * Unlike `killAgentSession` this takes a raw session name, so it also reaps the sessions no
 * agent owns — an orphan left by a removed workspace, or an ephemeral dashboard/view.
 */
export async function killQuimbyTmuxSession(name: string): Promise<boolean> {
  try {
    await execa('tmux', ['-L', quimbyTmuxSocket, 'kill-session', '-t', name])
    return true
  } catch {
    return false
  }
}

/**
 * Every session on quimby's tmux server, across all projects — the one place the whole
 * agent pool is visible, since `quimby list` only ever sees the current workspace's agents
 * and the socket is shared by every project on this machine.
 *
 * A missing tmux, or a server with no sessions at all, is an empty pool rather than an error:
 * both mean "nothing is running", which is exactly what the caller asked about.
 */
export async function listQuimbyTmuxSessions(): Promise<TmuxSessionSummary[]> {
  let stdout: string
  try {
    stdout = (await execa('tmux', ['-L', quimbyTmuxSocket, 'list-sessions', '-F', FORMAT])).stdout
  } catch {
    return []
  }

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseSessionLine)
    .filter((session): session is TmuxSessionSummary => session !== null)
}

// The four trailing fields are the numeric ones, so the line is split from the RIGHT and
// whatever precedes them is the name — a session name containing the separator cannot corrupt
// the parse (tmux permits `|` in a name even though quimby's own names never use it).
function parseSessionLine(line: string): TmuxSessionSummary | null {
  const parts = line.split(SEPARATOR)
  if (parts.length < 5) return null
  const [attached, windows, created, activity] = parts.slice(-4)
  const name = parts.slice(0, -4).join(SEPARATOR)
  if (!name) return null
  // tmux reports both timestamps in epoch *seconds*; everything above the transport speaks ms.
  const createdAt = Number(created) * 1000
  const activityAt = Number(activity) * 1000
  return {
    name,
    attached: attached !== '0',
    windows: Number(windows) || 0,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    activityAt: Number.isFinite(activityAt) ? activityAt : 0,
  }
}

// A tab would be the natural field separator, but tmux rewrites tabs in `-F` output (3.6 emits
// `_`), which silently collapses every field into the name — so the separator is a printable
// character tmux passes through untouched, and `parseSessionLine` splits from the right.
const SEPARATOR = '|'
const FORMAT = [
  '#{session_name}',
  '#{session_attached}',
  '#{session_windows}',
  '#{session_created}',
  '#{session_activity}',
].join(SEPARATOR)
