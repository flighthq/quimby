import { describe, expect, it, vi } from 'vitest'

const execa = vi.hoisted(() => vi.fn())
vi.mock('execa', () => ({ execa }))

let resolved: unknown

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
}))

function workspace(agents: Record<string, unknown>) {
  return { state: { id: 'proj-id', agents, subscriptions: {} }, repoRoot: '/fake/root' }
}

describe('runLogCommand', () => {
  it('throws when the agent does not exist', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./log')
    await expect(cmd.run!({ args: { agent: 'ghost' } } as never)).rejects.toThrow('not found')
  })

  it('errors clearly when the agent has no live tmux session', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    execa.mockRejectedValueOnce(new Error("can't find pane: qb-b1"))
    const { default: cmd } = await import('./log')
    await expect(cmd.run!({ args: { agent: 'builder' } } as never)).rejects.toThrow(
      /no live tmux session/,
    )
  })
})
