import { describe, expect, it, vi } from 'vitest'

const renameAgent = vi.hoisted(() => vi.fn(async () => {}))
const renameAgentWindow = vi.hoisted(() => vi.fn(async () => false))

vi.mock('@quimbyhq/agent', () => ({ renameAgent }))
vi.mock('@quimbyhq/session', () => ({ renameAgentWindow }))

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

describe('run', () => {
  it('is a function', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./rename')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when agent does not exist', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./rename')
    await expect(
      cmd.run!({ args: { agent: 'nonexistent', newName: 'bob' } } as never),
    ).rejects.toThrow()
  })

  it('pushes the new label onto the agent live tmux window', async () => {
    resolved = workspace({
      old: { id: 'a1', name: 'old', location: { type: 'local' }, tmux: true },
    })
    renameAgent.mockClear()
    renameAgentWindow.mockClear()
    const { default: cmd } = await import('./rename')
    await cmd.run!({ args: { agent: 'old', newName: 'new' } } as never)
    expect(renameAgent).toHaveBeenCalledWith('/fake/root', 'old', 'new')
    expect(renameAgentWindow).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), 'new')
  })
})
