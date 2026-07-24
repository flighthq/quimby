import { collectingReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'
import { describe, expect, it, vi } from 'vitest'

const getPoolInventory = vi.hoisted(() => vi.fn())
const prunePoolSessions = vi.hoisted(() => vi.fn())
vi.mock('@quimbyhq/pool', () => ({ getPoolInventory, prunePoolSessions }))

import { autoReapIdleSessions } from './autoreap'

const state = { id: 'proj', agents: {} } as unknown as QuimbyState

describe('autoReapIdleSessions', () => {
  it('reaps this project idle sessions and reports each one', async () => {
    const inventory = { projects: [], orphans: [], totals: {} }
    getPoolInventory.mockResolvedValueOnce(inventory)
    prunePoolSessions.mockResolvedValueOnce({
      killed: [{ name: 'qb-x', agentName: 'builder', idleMs: 4 * 3_600_000 }],
      missed: [],
    })
    const { reporter, events } = collectingReporter()

    const count = await autoReapIdleSessions(state, 2 * 3_600_000, reporter)

    expect(count).toBe(1)
    expect(getPoolInventory).toHaveBeenCalledWith({ currentState: state })
    // Scoped to this project and gated on the idle threshold — never another workspace's pool.
    expect(prunePoolSessions).toHaveBeenCalledWith(inventory, {
      idleMs: 2 * 3_600_000,
      projectId: 'proj',
    })
    expect(events.some((e) => e.message.includes('Reaped "builder"'))).toBe(true)
    expect(events.some((e) => e.message.includes('idle 4h'))).toBe(true)
  })

  it('reports nothing and returns 0 when no session is idle enough', async () => {
    getPoolInventory.mockResolvedValueOnce({ projects: [], orphans: [], totals: {} })
    prunePoolSessions.mockResolvedValueOnce({ killed: [], missed: [] })
    const { reporter, events } = collectingReporter()

    expect(await autoReapIdleSessions(state, 3_600_000, reporter)).toBe(0)
    expect(events).toHaveLength(0)
  })
})
