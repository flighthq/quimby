import { describe, expect, it, vi } from 'vitest'

const killQuimbyTmuxSession = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@quimbyhq/session', () => ({ killQuimbyTmuxSession }))

import type { PoolInventory, PoolSession } from './inventory'
import { prunePoolSessions, selectPrunablePoolSessions } from './prune'

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
        session({ name: 'qb-attached', agentName: 'review', attached: true, idleMs: 99_999_999, projectId: 'p1' }), // prettier-ignore
        session({ name: 'qb-fresh', agentName: 'builder', idleMs: 60_000, projectId: 'p1' }),
        session({ name: 'qb-stale', agentName: 'builder3', idleMs: 4 * 3_600_000, projectId: 'p1' }), // prettier-ignore
        session({ name: 'qb-dash-p1', kind: 'dashboard', idleMs: 9 * 3_600_000, projectId: 'p1' }),
      ],
    },
    {
      id: 'p2',
      label: 'flight',
      sessions: [session({ name: 'qb-other', agentName: 'api', idleMs: 6 * 3_600_000, projectId: 'p2' })], // prettier-ignore
    },
  ],
  orphans: [session({ name: 'qb-ghost', idleMs: 30_000, orphan: true })],
  totals: { sessions: 6, agents: 5, attached: 1, orphans: 1 },
}

describe('prunePoolSessions', () => {
  it('kills each selected session and reports what it got', async () => {
    killQuimbyTmuxSession.mockClear()
    const result = await prunePoolSessions(inventory, { idleMs: 2 * 3_600_000 })

    expect(result.killed.map((s) => s.name)).toEqual(['qb-other', 'qb-stale'])
    expect(result.missed).toEqual([])
    expect(killQuimbyTmuxSession).toHaveBeenCalledTimes(2)
  })

  it('reports a session that vanished before the kill as missed, not killed', async () => {
    killQuimbyTmuxSession.mockClear()
    killQuimbyTmuxSession.mockResolvedValueOnce(false)

    const result = await prunePoolSessions(inventory, { orphans: true })

    expect(result.killed).toEqual([])
    expect(result.missed.map((s) => s.name)).toEqual(['qb-ghost'])
  })
})

describe('selectPrunablePoolSessions', () => {
  it('selects agent sessions past the idle threshold, idlest first', () => {
    expect(
      selectPrunablePoolSessions(inventory, { idleMs: 2 * 3_600_000 }).map((s) => s.name),
    ).toEqual(['qb-other', 'qb-stale'])
  })

  it('never selects an attached session, however idle', () => {
    expect(selectPrunablePoolSessions(inventory, { idleMs: 1 }).map((s) => s.name)).not.toContain(
      'qb-attached',
    )
  })

  it('leaves dashboards and views alone on age (they tear themselves down)', () => {
    expect(selectPrunablePoolSessions(inventory, { idleMs: 1 }).map((s) => s.name)).not.toContain(
      'qb-dash-p1',
    )
  })

  it('selects orphans at any idle time when asked', () => {
    expect(selectPrunablePoolSessions(inventory, { orphans: true }).map((s) => s.name)).toEqual([
      'qb-ghost',
    ])
  })

  it('scopes a sweep to one project', () => {
    expect(
      selectPrunablePoolSessions(inventory, { idleMs: 2 * 3_600_000, projectId: 'p1' }).map(
        (s) => s.name,
      ),
    ).toEqual(['qb-stale'])
  })

  it('selects nothing when neither an idle threshold nor orphans are asked for', () => {
    expect(selectPrunablePoolSessions(inventory, {})).toEqual([])
  })
})
