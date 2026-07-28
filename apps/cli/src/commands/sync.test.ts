import { afterEach, describe, expect, it, vi } from 'vitest'

const syncAgents = vi.hoisted(() => vi.fn())
const offerConflictNudge = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../conflictNudge', () => ({ offerConflictNudge }))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', agents: {} },
    repoRoot: '/fake/root',
  })),
}))
// Default syncAgents to the real implementation so the existing validation tests
// (name-or-all required, not-found) keep exercising real behavior; the dedupe test
// overrides per-call.
vi.mock('@quimbyhq/agent', async (importOriginal) => {
  const actual = (await importOriginal()) as { syncAgents: typeof syncAgents }
  syncAgents.mockImplementation(actual.syncAgents as never)
  return { ...actual, syncAgents }
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('runSyncCommand', () => {
  it('offers the resolve-conflict nudge when a rebase conflict rolls back cleanly', async () => {
    const { SyncConflictError } = await import('@quimbyhq/errors')
    const workspace = await import('@quimbyhq/workspace')
    vi.mocked(workspace.resolveWorkspace).mockResolvedValueOnce({
      state: {
        id: 'proj-id',
        sourceRef: 'main',
        agents: { builder: { id: 'b', name: 'builder', syncRef: 'main' } },
      },
      repoRoot: '/fake/root',
    } as never)
    syncAgents.mockRejectedValueOnce(new SyncConflictError('conflicts with main', true))

    const { default: cmd } = await import('./sync')
    await expect(
      cmd.run!({ args: { agent: 'builder', all: false, force: false, current: false } } as never),
    ).rejects.toThrow(/conflicts with main/)

    expect(offerConflictNudge).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'builder',
        syncRef: 'main',
        whenNonInteractive: 'print',
      }),
    )
  })

  it('does not offer a nudge when the agent repo is wedged (agentClean false)', async () => {
    const { SyncConflictError } = await import('@quimbyhq/errors')
    const workspace = await import('@quimbyhq/workspace')
    vi.mocked(workspace.resolveWorkspace).mockResolvedValueOnce({
      state: {
        id: 'proj-id',
        sourceRef: 'main',
        agents: { builder: { id: 'b', name: 'builder' } },
      },
      repoRoot: '/fake/root',
    } as never)
    syncAgents.mockRejectedValueOnce(new SyncConflictError('wedged', false))

    const { default: cmd } = await import('./sync')
    await expect(
      cmd.run!({ args: { agent: 'builder', all: false, force: false, current: false } } as never),
    ).rejects.toThrow(/wedged/)
    expect(offerConflictNudge).not.toHaveBeenCalled()
  })

  it('is a function', async () => {
    const { default: cmd } = await import('./sync')
    expect(typeof cmd.run).toBe('function')
  })

  it('requires a name or --all', async () => {
    const { default: cmd } = await import('./sync')
    await expect(cmd.run!({ args: { all: false, force: false } } as never)).rejects.toThrow(
      'Specify',
    )
  })

  it('throws when the agent does not exist', async () => {
    const { default: cmd } = await import('./sync')
    await expect(
      cmd.run!({ args: { agent: 'ghost', all: false, force: false } } as never),
    ).rejects.toThrow('not found')
  })

  it('dedupes positionals and forwards the flags into syncAgents', async () => {
    syncAgents.mockResolvedValueOnce(undefined as never)
    const { default: cmd } = await import('./sync')
    await cmd.run!({
      args: {
        agent: 'a',
        _: ['a', 'b', 'a'],
        all: false,
        force: true,
        base: 'release',
        current: true,
      },
    } as never)
    expect(syncAgents).toHaveBeenCalledTimes(1)
    expect(syncAgents.mock.calls[0][0]).toMatchObject({
      names: ['a', 'b'],
      all: false,
      force: true,
      base: 'release',
      current: true,
    })
  })
})
