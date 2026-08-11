import { collectingReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/git', () => ({
  getCurrentBranch: vi.fn(async () => 'main'),
}))
vi.mock('./sync', () => ({
  syncAgent: vi.fn(),
}))

import { getCurrentBranch } from '@quimbyhq/git'

import { syncAgent } from './sync'
import { syncAgents } from './syncAgents'

const mockedBranch = vi.mocked(getCurrentBranch)
const mockedSync = vi.mocked(syncAgent)

function stateWith(agents: Record<string, { seedCommit?: string; syncRef?: string }>): QuimbyState {
  const built: Record<string, unknown> = {}
  for (const [name, a] of Object.entries(agents)) {
    built[name] = { id: `${name}-id`, name, location: { type: 'local' }, ...a }
  }
  return {
    id: 'proj',
    sourceRef: 'main',
    agents: built,
  } as unknown as QuimbyState
}

function opts(overrides: Record<string, unknown>) {
  return {
    state: stateWith({ alice: { seedCommit: 'old', syncRef: 'main' } }),
    repoRoot: '/r',
    names: ['alice'],
    all: false,
    force: false,
    current: false,
    ...overrides,
  } as Parameters<typeof syncAgents>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedBranch.mockResolvedValue('main')
  mockedSync.mockResolvedValue({
    newSeed: 'newseed01',
    rebased: false,
    commitsReplayed: 0,
    baseCommit: 'newseed',
    applied: true,
    edgesUpdated: false,
  })
})

describe('syncAgents', () => {
  it('throws when no names and not --all', async () => {
    await expect(syncAgents(opts({ names: [] }))).rejects.toThrow(/Specify one or more/)
  })

  it('rejects --base together with --current', async () => {
    await expect(syncAgents(opts({ base: 'dev', current: true }))).rejects.toThrow(/not both/)
  })

  it('rejects --base together with --all', async () => {
    await expect(syncAgents(opts({ all: true, names: [], base: 'dev' }))).rejects.toThrow(
      /use it with a name/,
    )
  })

  it('rejects --current when HEAD is detached', async () => {
    mockedBranch.mockResolvedValue(undefined)
    await expect(syncAgents(opts({ current: true }))).rejects.toThrow(/detached/)
  })

  it('throws when a named agent does not exist', async () => {
    await expect(syncAgents(opts({ names: ['ghost'] }))).rejects.toThrow(/not found/)
  })

  it('reports no agents to sync when --all finds an empty roster', async () => {
    const { reporter, events } = collectingReporter()
    const result = await syncAgents(opts({ all: true, names: [], state: stateWith({}) }), reporter)
    expect(result).toEqual([])
    expect(events).toContainEqual({ level: 'info', message: 'No agents to sync.' })
  })

  it('classifies a forced hard-reset', async () => {
    mockedSync.mockResolvedValue({
      newSeed: 'forced01',
      rebased: false,
      commitsReplayed: 0,
      baseCommit: 'newseed',
      applied: true,
      edgesUpdated: false,
    })
    const [outcome] = await syncAgents(opts({ force: true }))
    expect(outcome).toMatchObject({ name: 'alice', outcome: 'forced', newSeed: 'forced01' })
    expect(mockedSync).toHaveBeenCalledWith('/r', 'alice', {
      force: true,
      base: undefined,
      syncedProjects: expect.any(Set),
    })
  })

  it('classifies an up-to-date agent (seed unchanged)', async () => {
    mockedSync.mockResolvedValue({
      newSeed: 'old',
      rebased: false,
      commitsReplayed: 0,
      baseCommit: 'newseed',
      applied: true,
      edgesUpdated: false,
    })
    const [outcome] = await syncAgents(opts({}))
    expect(outcome.outcome).toBe('up-to-date')
  })

  it('classifies a rebased agent', async () => {
    mockedSync.mockResolvedValue({
      newSeed: 'newseed01',
      rebased: true,
      commitsReplayed: 3,
      baseCommit: 'newseed',
      applied: true,
      edgesUpdated: false,
    })
    const [outcome] = await syncAgents(opts({}))
    expect(outcome).toMatchObject({ outcome: 'rebased', commitsReplayed: 3 })
  })

  it('classifies a fast-forward (advanced but no commits to replay)', async () => {
    mockedSync.mockResolvedValue({
      newSeed: 'newseed01',
      rebased: false,
      commitsReplayed: 0,
      baseCommit: 'newseed',
      applied: true,
      edgesUpdated: false,
    })
    const [outcome] = await syncAgents(opts({}))
    expect(outcome.outcome).toBe('fast-forwarded')
  })

  it('resolves --current to the host branch and passes it as the base', async () => {
    mockedBranch.mockResolvedValue('feature/x')
    await syncAgents(opts({ current: true }))
    expect(mockedSync).toHaveBeenCalledWith('/r', 'alice', {
      force: false,
      base: 'feature/x',
      syncedProjects: expect.any(Set),
    })
  })

  it('under --all, skips a conflicted agent and continues', async () => {
    mockedSync.mockRejectedValueOnce(new Error('rebase conflicts')).mockResolvedValueOnce({
      newSeed: 'n',
      rebased: false,
      commitsReplayed: 0,
      baseCommit: 'newseed',
      applied: true,
      edgesUpdated: false,
    })

    const outcomes = await syncAgents(
      opts({
        all: true,
        names: [],
        state: stateWith({ alice: { seedCommit: 'old' }, bob: { seedCommit: 'old' } }),
      }),
    )

    expect(outcomes.find((o) => o.name === 'alice')).toMatchObject({ outcome: 'skipped' })
    expect(outcomes.find((o) => o.name === 'bob')?.outcome).not.toBe('skipped')
  })

  it('for an explicit name, a conflict throws instead of skipping', async () => {
    mockedSync.mockRejectedValue(new Error('rebase conflicts'))
    await expect(syncAgents(opts({}))).rejects.toThrow(/rebase conflicts/)
  })

  // Every SSH agent on a host shares one remote project root, so the sweep must carry ONE memo
  // across the whole run — otherwise each agent re-pushes the identical tree, multiplying the wall
  // time and the exposure to a transient rsync failure that turns an agent into a `skipped`.
  it('threads one project-sync memo across every agent in the sweep', async () => {
    await syncAgents(
      opts({
        all: true,
        names: [],
        state: stateWith({ alice: { seedCommit: 'old' }, bob: { seedCommit: 'old' } }),
      }),
    )

    const memos = mockedSync.mock.calls.map((c) => c[2]?.syncedProjects)
    expect(memos).toHaveLength(2)
    expect(memos[0]).toBeInstanceOf(Set)
    expect(memos[1]).toBe(memos[0])
  })
})
