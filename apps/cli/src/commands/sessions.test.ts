import { logger } from '@quimbyhq/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getPoolInventory = vi.hoisted(() => vi.fn())
const getPoolCapacity = vi.hoisted(() => vi.fn<() => unknown>(() => null))
const getPoolIdleTimeoutMs = vi.hoisted(() => vi.fn<() => number | null>(() => null))
const prunePoolSessions = vi.hoisted(() =>
  vi.fn<() => Promise<{ killed: unknown[]; missed: unknown[] }>>(async () => ({
    killed: [],
    missed: [],
  })),
)
const selectPrunablePoolSessions = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))

vi.mock('@quimbyhq/pool', () => ({
  getPoolInventory,
  getPoolCapacity,
  getPoolIdleTimeoutMs,
  prunePoolSessions,
  selectPrunablePoolSessions,
}))

let resolved: { state?: { id: string } } | null = { state: { id: 'proj' } }
vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => {
    if (!resolved) throw new Error('no workspace')
    return resolved
  }),
  loadQuimbyConfig: vi.fn(async () => ({})),
}))

const emptyInventory = { projects: [], orphans: [], totals: { sessions: 0, agents: 0, attached: 0, orphans: 0 } } // prettier-ignore

afterEach(() => {
  vi.clearAllMocks()
  resolved = { state: { id: 'proj' } }
  getPoolCapacity.mockReturnValue(null)
  getPoolIdleTimeoutMs.mockReturnValue(null)
  prunePoolSessions.mockResolvedValue({ killed: [], missed: [] })
  selectPrunablePoolSessions.mockReturnValue([])
})

describe('runSessionsCommand', () => {
  it('reports no sessions when the pool is empty', async () => {
    getPoolInventory.mockResolvedValueOnce(emptyInventory)
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const { runSessionsCommand } = await import('./sessions')
    await runSessionsCommand({ rawArgs: [] })
    expect(info.mock.calls.some((c) => String(c[0]).includes('No live quimby sessions'))).toBe(true)
  })

  it('stands down when the invocation was `sessions prune` (parent run fires after the sub)', async () => {
    const { runSessionsCommand } = await import('./sessions')
    await runSessionsCommand({ rawArgs: ['prune', '--orphans'] })
    expect(getPoolInventory).not.toHaveBeenCalled()
  })

  it('reads the pool without a workspace when run outside a project', async () => {
    resolved = null
    getPoolInventory.mockResolvedValueOnce(emptyInventory)
    const { runSessionsCommand } = await import('./sessions')
    await runSessionsCommand({ rawArgs: [] })
    expect(getPoolInventory).toHaveBeenCalledWith({})
  })
})

describe('runSessionsPruneCommand', () => {
  it('throws when neither --idle nor --orphans is given', async () => {
    const { runSessionsPruneCommand } = await import('./sessions')
    await expect(runSessionsPruneCommand({ args: {} })).rejects.toThrow(/Nothing selected/)
  })

  it('throws on an unparseable --idle value', async () => {
    const { runSessionsPruneCommand } = await import('./sessions')
    await expect(runSessionsPruneCommand({ args: { idle: 'soon' } })).rejects.toThrow(/duration/)
  })

  it('previews without killing when --force is absent', async () => {
    getPoolInventory.mockResolvedValueOnce(emptyInventory)
    selectPrunablePoolSessions.mockReturnValueOnce([
      { name: 'qb-x', agentName: 'builder', idleMs: 7_200_000, attached: false, kind: 'agent', orphan: false }, // prettier-ignore
    ])
    const { runSessionsPruneCommand } = await import('./sessions')
    await runSessionsPruneCommand({ args: { idle: '2h' } })
    expect(prunePoolSessions).not.toHaveBeenCalled()
  })

  it('kills the selected sessions with --force', async () => {
    getPoolInventory.mockResolvedValueOnce(emptyInventory)
    selectPrunablePoolSessions.mockReturnValueOnce([{ name: 'qb-x', kind: 'agent' }])
    prunePoolSessions.mockResolvedValueOnce({
      killed: [{ name: 'qb-x', agentName: 'builder' }],
      missed: [],
    })
    vi.spyOn(logger, 'success').mockImplementation(() => {})
    const { runSessionsPruneCommand } = await import('./sessions')
    await runSessionsPruneCommand({ args: { orphans: true, force: true } })
    expect(prunePoolSessions).toHaveBeenCalledWith(emptyInventory, { orphans: true })
  })

  it('throws when --here is used with no workspace', async () => {
    resolved = null
    getPoolInventory.mockResolvedValueOnce(emptyInventory)
    const { runSessionsPruneCommand } = await import('./sessions')
    await expect(runSessionsPruneCommand({ args: { orphans: true, here: true } })).rejects.toThrow(
      /--here needs a quimby workspace/,
    )
  })

  it('scopes the sweep to the current project with --here', async () => {
    getPoolInventory.mockResolvedValueOnce(emptyInventory)
    selectPrunablePoolSessions.mockReturnValueOnce([])
    const { runSessionsPruneCommand } = await import('./sessions')
    await runSessionsPruneCommand({ args: { idle: '2h', here: true } })
    expect(selectPrunablePoolSessions).toHaveBeenCalledWith(emptyInventory, {
      idleMs: 7_200_000,
      projectId: 'proj',
    })
  })
})
