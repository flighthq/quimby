import { dashboardSessionName, dashboardViewSessionName, tmuxSessionName } from '@quimbyhq/paths'
import type { QuimbyState } from '@quimbyhq/types'
import { describe, expect, it, vi } from 'vitest'

const listQuimbyTmuxSessions = vi.hoisted(() => vi.fn())
const listStorageWorkspaces = vi.hoisted(() => vi.fn(async () => []))
const readStoredState = vi.hoisted(() => vi.fn())

vi.mock('@quimbyhq/session', () => ({ listQuimbyTmuxSessions }))
vi.mock('@quimbyhq/workspace', () => ({ listStorageWorkspaces, readStoredState }))

import { classifyPoolSession, getPoolInventory, loadWorkspaceOwners } from './inventory'

const NOW = 1_700_000_000_000
const PROJECT = '1925346d-3bd2-4de6-b176-9df59e6355aa'
const state = {
  id: PROJECT,
  agents: {
    review: { id: 'c0a44955-1111-2222-3333-444444444444' },
    builder: { id: 'be3280d0-1111-2222-3333-444444444444' },
  },
} as unknown as QuimbyState

const owners = {
  projects: new Map([[PROJECT, { id: PROJECT, label: 'quimby', repoRoot: '/dev/quimby' }]]),
  agents: new Map([
    ['c0a44955', { projectId: PROJECT, agentName: 'review' }],
    ['be3280d0', { projectId: PROJECT, agentName: 'builder' }],
  ]),
}

const summary = (name: string, over: Partial<{ attached: boolean; activityAt: number }> = {}) => ({
  name,
  attached: over.attached ?? false,
  windows: 1,
  createdAt: NOW - 7_200_000,
  activityAt: over.activityAt ?? NOW,
})

describe('classifyPoolSession', () => {
  it('resolves an agent session to its workspace and display name', () => {
    const session = classifyPoolSession(summary('qb-c0a44955'), NOW, owners)
    expect(session).toMatchObject({
      kind: 'agent',
      agentId: 'c0a44955',
      agentName: 'review',
      projectId: PROJECT,
      orphan: false,
      idleMs: 0,
    })
  })

  it('marks an agent session no workspace claims as an orphan', () => {
    const session = classifyPoolSession(summary('qb-deadbeef'), NOW, owners)
    expect(session).toMatchObject({ kind: 'agent', agentId: 'deadbeef', orphan: true })
    expect(session.agentName).toBeUndefined()
  })

  it('classifies dashboard and view sessions by project id', () => {
    expect(classifyPoolSession(summary(`qb-dash-${PROJECT}`), NOW, owners)).toMatchObject({
      kind: 'dashboard',
      projectId: PROJECT,
      orphan: false,
    })
    expect(classifyPoolSession(summary(`qbv-${PROJECT}-1`), NOW, owners)).toMatchObject({
      kind: 'view',
      projectId: PROJECT,
      orphan: false,
    })
  })

  it('orphans a dashboard or view whose project is gone', () => {
    expect(classifyPoolSession(summary('qb-dash-vanished'), NOW, owners)).toMatchObject({
      kind: 'dashboard',
      orphan: true,
    })
    expect(classifyPoolSession(summary('qbv-vanished-0'), NOW, owners)).toMatchObject({
      kind: 'view',
      orphan: true,
    })
  })

  it('computes idle time from the last activity, never negative', () => {
    expect(classifyPoolSession(summary('qb-c0a44955', { activityAt: NOW - 3_600_000 }), NOW, owners).idleMs).toBe(3_600_000) // prettier-ignore
    expect(classifyPoolSession(summary('qb-c0a44955', { activityAt: NOW + 5000 }), NOW, owners).idleMs).toBe(0) // prettier-ignore
  })

  it('treats a session quimby did not mint as unknown', () => {
    expect(classifyPoolSession(summary('scratch'), NOW, owners)).toMatchObject({
      kind: 'unknown',
      orphan: true,
    })
  })

  // The prefixes are held as literals in inventory.ts; pin them against the paths builders so a
  // rename there fails loudly instead of quietly reclassifying every session as an orphan.
  it('matches the session names @quimbyhq/paths actually mints', () => {
    expect(classifyPoolSession(summary(tmuxSessionName('c0a44955-x')), NOW, owners).kind).toBe('agent') // prettier-ignore
    expect(classifyPoolSession(summary(dashboardSessionName(PROJECT)), NOW, owners).kind).toBe('dashboard') // prettier-ignore
    expect(classifyPoolSession(summary(dashboardViewSessionName(PROJECT, 2)), NOW, owners).kind).toBe('view') // prettier-ignore
  })
})

describe('getPoolInventory', () => {
  it('groups sessions by project, separates orphans, and totals the pool', async () => {
    listStorageWorkspaces.mockResolvedValueOnce([
      { id: PROJECT, path: '/storage', registered: true, repoRoot: '/dev/quimby', exists: true },
    ] as never)
    readStoredState.mockResolvedValueOnce(state)
    listQuimbyTmuxSessions.mockResolvedValueOnce([
      summary('qb-c0a44955', { attached: true }),
      summary('qb-be3280d0', { activityAt: NOW - 3_600_000 }),
      summary(`qb-dash-${PROJECT}`),
      summary('qb-deadbeef', { activityAt: NOW - 86_400_000 }),
    ])

    const inventory = await getPoolInventory({ now: NOW })

    expect(inventory.projects).toHaveLength(1)
    expect(inventory.projects[0].label).toBe('quimby')
    expect(inventory.projects[0].sessions.map((s) => s.name)).toEqual([
      'qb-c0a44955',
      `qb-dash-${PROJECT}`,
      'qb-be3280d0',
    ])
    expect(inventory.orphans.map((s) => s.name)).toEqual(['qb-deadbeef'])
    expect(inventory.totals).toEqual({ sessions: 4, agents: 3, attached: 1, orphans: 1 })
  })

  it('is an empty pool when nothing is running', async () => {
    listQuimbyTmuxSessions.mockResolvedValueOnce([])
    const inventory = await getPoolInventory({ now: NOW })
    expect(inventory.projects).toEqual([])
    expect(inventory.totals.sessions).toBe(0)
  })
})

describe('loadWorkspaceOwners', () => {
  it('indexes durable workspaces by project id and short agent id', async () => {
    listStorageWorkspaces.mockResolvedValueOnce([
      { id: PROJECT, path: '/storage', registered: true, repoRoot: '/dev/quimby', exists: true },
    ] as never)
    readStoredState.mockResolvedValueOnce(state)

    const resolved = await loadWorkspaceOwners()

    expect(resolved.projects.get(PROJECT)).toEqual({
      id: PROJECT,
      label: 'quimby',
      repoRoot: '/dev/quimby',
    })
    expect(resolved.agents.get('be3280d0')).toEqual({ projectId: PROJECT, agentName: 'builder' })
  })

  it('skips a workspace whose stored state cannot be read', async () => {
    listStorageWorkspaces.mockResolvedValueOnce([
      { id: 'broken', path: '/storage', registered: true, exists: true },
    ] as never)
    readStoredState.mockRejectedValueOnce(new Error('missing state.yaml'))

    expect((await loadWorkspaceOwners()).projects.size).toBe(0)
  })

  it('folds in the current workspace even when it has no durable storage yet', async () => {
    listStorageWorkspaces.mockResolvedValueOnce([] as never)
    const resolved = await loadWorkspaceOwners(state)
    expect(resolved.projects.get(PROJECT)?.label).toBe(PROJECT.slice(0, 8))
    expect(resolved.agents.get('c0a44955')?.agentName).toBe('review')
  })
})
