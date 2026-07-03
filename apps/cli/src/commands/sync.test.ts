import { afterEach, describe, expect, it, vi } from 'vitest'

const syncAgents = vi.hoisted(() => vi.fn())

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', agents: {}, subscriptions: {} },
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

describe('run', () => {
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
