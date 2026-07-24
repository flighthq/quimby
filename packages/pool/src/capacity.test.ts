import { describe, expect, it } from 'vitest'

import { getPoolCapacity, getPoolIdleTimeoutMs, poolCapacityWarning } from './capacity'
import type { PoolInventory, PoolSession } from './inventory'

const session = (over: Partial<PoolSession> & Pick<PoolSession, 'name'>): PoolSession => ({
  attached: false,
  windows: 1,
  createdAt: 0,
  activityAt: 0,
  kind: 'agent',
  idleMs: 0,
  orphan: false,
  ...over,
})

const inventory: PoolInventory = {
  projects: [
    {
      id: 'p1',
      label: 'quimby',
      sessions: [
        session({ name: 'qb-1', agentName: 'review', attached: true, idleMs: 0 }),
        session({ name: 'qb-2', agentName: 'builder', idleMs: 4 * 3_600_000 }),
        session({ name: 'qb-3', kind: 'dashboard', idleMs: 9 * 3_600_000 }),
      ],
    },
    { id: 'p2', label: 'flight', sessions: [session({ name: 'qb-4', agentName: 'api', idleMs: 60_000 })] }, // prettier-ignore
  ],
  orphans: [session({ name: 'qb-ghost', idleMs: 30_000, orphan: true })],
  totals: { sessions: 5, agents: 4, attached: 1, orphans: 1 },
}

describe('getPoolCapacity', () => {
  it('counts agent sessions across every project, ignoring dashboards', () => {
    expect(getPoolCapacity(inventory, { pool: { maxLive: 3 } })).toMatchObject({
      live: 4,
      maxLive: 3,
    })
  })

  it('offers the idlest unattached agents as reap candidates, worst first', () => {
    expect(getPoolCapacity(inventory, { pool: { maxLive: 3 } })?.idlest.map((s) => s.name)).toEqual(
      ['qb-2', 'qb-4', 'qb-ghost'],
    )
  })

  it('is null when no ceiling is configured', () => {
    expect(getPoolCapacity(inventory, {})).toBeNull()
    expect(getPoolCapacity(inventory, undefined)).toBeNull()
    expect(getPoolCapacity(inventory, { pool: { maxLive: 0 } })).toBeNull()
  })
})

describe('getPoolIdleTimeoutMs', () => {
  it('parses a configured threshold', () => {
    expect(getPoolIdleTimeoutMs({ pool: { idleTimeout: '2h' } })).toBe(7_200_000)
  })

  it('is null when unset, unparseable, or zero — auto-reaping stays opt-in', () => {
    expect(getPoolIdleTimeoutMs(undefined)).toBeNull()
    expect(getPoolIdleTimeoutMs({})).toBeNull()
    expect(getPoolIdleTimeoutMs({ pool: { idleTimeout: 'whenever' } })).toBeNull()
    expect(getPoolIdleTimeoutMs({ pool: { idleTimeout: '0m' } })).toBeNull()
  })
})

describe('poolCapacityWarning', () => {
  it('warns at or past the ceiling, naming the idlest and the fix', () => {
    const warning = poolCapacityWarning(getPoolCapacity(inventory, { pool: { maxLive: 3 } }))
    expect(warning).toContain('4 agent sessions are live')
    expect(warning).toContain('pool.maxLive: 3')
    expect(warning).toContain('builder (idle 4h)')
    expect(warning).toContain('quimby sessions prune')
  })

  it('is null with room to spare or no ceiling', () => {
    expect(poolCapacityWarning(getPoolCapacity(inventory, { pool: { maxLive: 9 } }))).toBeNull()
    expect(poolCapacityWarning(null)).toBeNull()
  })
})
