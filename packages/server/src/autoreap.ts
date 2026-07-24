import { getPoolInventory, prunePoolSessions } from '@quimbyhq/pool'
import type { Reporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'
import { formatDuration } from '@quimbyhq/utils'

/**
 * Close this workspace's agent sessions that have sat idle past `idleTimeoutMs` — the automatic
 * twin of `quimby sessions prune --idle`, run on the poll cycle when `pool.idleTimeout` is set.
 *
 * Two boundaries keep it safe. It never touches an **attached** session (someone is in it), and
 * it is scoped to **this** server's project — another workspace's sessions belong to that
 * workspace's server, so two servers can never fight over the same pool. Reaping ends only the
 * process: the agent's repo, assignment, status, and mailbox are on disk, so a reaped agent is
 * restarted with `quimby start` and resumes from its `status.md`.
 */
export async function autoReapIdleSessions(
  state: Readonly<QuimbyState>,
  idleTimeoutMs: number,
  reporter: Readonly<Reporter>,
): Promise<number> {
  const inventory = await getPoolInventory({ currentState: state })
  const { killed } = await prunePoolSessions(inventory, {
    idleMs: idleTimeoutMs,
    projectId: state.id,
  })
  for (const session of killed) {
    reporter.info(
      `Reaped "${session.agentName ?? session.name}" — idle ${formatDuration(session.idleMs)} (work on disk is untouched)`,
    )
  }
  return killed.length
}
