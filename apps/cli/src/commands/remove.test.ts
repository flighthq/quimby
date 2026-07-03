import { describe, expect, it, vi } from 'vitest'

const execa = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})))
const removeAgent = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('execa', () => ({ execa }))
vi.mock('@quimbyhq/agent', () => ({ removeAgent }))

let resolved: {
  state: { id: string; agents: Record<string, unknown>; subscriptions: object }
  repoRoot: string
}

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
  loadState: vi.fn(async () => ({ id: 'proj-id', agents: {}, subscriptions: {} })),
  saveState: vi.fn(),
}))

function workspace(agents: Record<string, unknown>) {
  return { state: { id: 'proj-id', agents, subscriptions: {} }, repoRoot: '/fake/root' }
}

describe('runRemoveCommand', () => {
  it('throws when the agent does not exist', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./remove')
    await expect(cmd.run!({ args: { agent: 'ghost', force: false } } as never)).rejects.toThrow(
      'not found',
    )
  })

  it('warns and removes nothing without --force (destructive-action gate)', async () => {
    resolved = workspace({
      builder: { id: 'b1', name: 'builder', location: { type: 'local' }, tmux: true },
    })
    execa.mockClear()
    removeAgent.mockClear()
    const { default: cmd } = await import('./remove')
    await cmd.run!({ args: { agent: 'builder', force: false } } as never)
    expect(removeAgent).not.toHaveBeenCalled()
    expect(execa).not.toHaveBeenCalled()
  })

  it('kills the tmux session for a running local agent before removing it', async () => {
    resolved = workspace({
      builder: { id: 'b1', name: 'builder', location: { type: 'local' }, tmux: true },
    })
    execa.mockClear()
    removeAgent.mockClear()
    const { default: cmd } = await import('./remove')
    await cmd.run!({ args: { agent: 'builder', force: true } } as never)
    const argv = execa.mock.calls[0]?.[1] as string[]
    expect(argv).toContain('kill-session')
    expect(removeAgent).toHaveBeenCalledWith('/fake/root', 'builder')
  })

  it('does not attempt a tmux kill for a local agent that was never run', async () => {
    resolved = workspace({ plain: { id: 'p1', name: 'plain', location: { type: 'local' } } })
    execa.mockClear()
    removeAgent.mockClear()
    const { default: cmd } = await import('./remove')
    await cmd.run!({ args: { agent: 'plain', force: true } } as never)
    expect(execa).not.toHaveBeenCalled()
    expect(removeAgent).toHaveBeenCalledWith('/fake/root', 'plain')
  })
})
