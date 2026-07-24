import type { QuimbyConfig } from '@quimbyhq/types'
import { formatDuration, parseDuration } from '@quimbyhq/utils'

import type { PoolInventory, PoolSession } from './inventory'

export interface PoolCapacity {
  live: number
  maxLive: number
  /** The idlest live agent sessions, worst first — what a warning offers up as reap candidates. */
  idlest: PoolSession[]
}

/**
 * The pool's live agent count against the configured ceiling, or `null` when no ceiling is set.
 * Counts agent sessions across *every* project on the socket, because that is what actually
 * competes for the machine — one project's roster says nothing about the load a second one adds.
 */
export function getPoolCapacity(
  inventory: Readonly<PoolInventory>,
  config: Readonly<QuimbyConfig> | undefined,
): PoolCapacity | null {
  const maxLive = config?.pool?.maxLive
  if (typeof maxLive !== 'number' || maxLive <= 0) return null
  const agents = [...inventory.projects.flatMap((p) => p.sessions), ...inventory.orphans].filter(
    (session) => session.kind === 'agent',
  )
  return {
    live: agents.length,
    maxLive,
    idlest: [...agents]
      .filter((session) => !session.attached)
      .sort((a, b) => b.idleMs - a.idleMs)
      .slice(0, 3),
  }
}

/** The configured auto-reap idle threshold in ms, or `null` when the server should not reap. */
export function getPoolIdleTimeoutMs(config: Readonly<QuimbyConfig> | undefined): number | null {
  const parsed = parseDuration(config?.pool?.idleTimeout)
  return parsed !== null && parsed > 0 ? parsed : null
}

/**
 * The warning text for launching past the ceiling, or `null` when there is room. Warn-only by
 * design: quimby names the cost and the cheapest fix, then launches anyway — the ceiling is a
 * budget the user set for themselves, not a lock, and refusing a launch mid-workflow would be
 * worse than the resource pressure it prevents.
 */
export function poolCapacityWarning(capacity: Readonly<PoolCapacity> | null): string | null {
  if (!capacity || capacity.live < capacity.maxLive) return null
  const idlest = capacity.idlest
    .map(
      (session) => `${session.agentName ?? session.name} (idle ${formatDuration(session.idleMs)})`,
    )
    .join(', ')
  return (
    `${capacity.live} agent sessions are live across all projects (pool.maxLive: ${capacity.maxLive}).` +
    (idlest ? ` Idlest: ${idlest}.` : '') +
    ' Free some with `quimby sessions prune --idle 2h --force`.'
  )
}
