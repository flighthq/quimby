import { killQuimbyTmuxSession } from '@quimbyhq/session'

import type { PoolInventory, PoolSession } from './inventory'

export interface PoolPruneOptions {
  /** Reap agent sessions idle at least this long. Omit to reap nothing on age alone. */
  idleMs?: number
  /** Reap sessions no workspace claims, whatever their idle time. */
  orphans?: boolean
  /** Restrict the sweep to one project id (the current workspace, typically). */
  projectId?: string
}

export interface PoolPruneResult {
  killed: PoolSession[]
  /** Selected but already gone by the time the kill ran — a benign race, not a failure. */
  missed: PoolSession[]
}

/**
 * Kill the selected sessions. Reaping only ends the *process*: the agent's repo, assignment,
 * status, and mailbox are on disk and untouched, so a reaped worker is restarted with
 * `quimby start`/`run` and resumes from its `status.md`. What is lost is the live context of
 * that session — which is the whole point of reaping an idle one.
 */
export async function prunePoolSessions(
  inventory: Readonly<PoolInventory>,
  opts: Readonly<PoolPruneOptions>,
): Promise<PoolPruneResult> {
  const killed: PoolSession[] = []
  const missed: PoolSession[] = []
  for (const session of selectPrunablePoolSessions(inventory, opts)) {
    if (await killQuimbyTmuxSession(session.name)) killed.push(session)
    else missed.push(session)
  }
  return { killed, missed }
}

/**
 * The sessions a sweep would reap, newest-idle last so a report reads worst-first.
 *
 * An **attached** session is never selected: someone is sitting in it, and killing a session out
 * from under a live client is the one surprise a pool sweep must not spring. Ephemeral dashboard
 * and view sessions are skipped too unless they are orphaned — they belong to a viewport that
 * tears itself down, so age says nothing about whether they are wanted.
 */
export function selectPrunablePoolSessions(
  inventory: Readonly<PoolInventory>,
  opts: Readonly<PoolPruneOptions>,
): PoolSession[] {
  const all = [...inventory.projects.flatMap((p) => p.sessions), ...inventory.orphans]
  const selected = all.filter((session) => {
    if (session.attached) return false
    if (opts.projectId && session.projectId !== opts.projectId) return false
    if (opts.orphans && session.orphan) return true
    if (opts.idleMs === undefined) return false
    if (session.kind !== 'agent') return false
    return session.idleMs >= opts.idleMs
  })
  return selected.sort((a, b) => b.idleMs - a.idleMs)
}
