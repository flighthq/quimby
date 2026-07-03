import { describe, expect, it, vi } from 'vitest'

const sessionState = vi.hoisted(() => vi.fn(async () => 'stopped'))
const execa = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})))

vi.mock('execa', () => ({ execa }))
vi.mock('@quimbyhq/session', () => ({ getAgentSessionState: sessionState }))

let resolved: {
  state: { id: string; agents: Record<string, unknown>; subscriptions: object }
  repoRoot: string
}

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
}))

function workspace(agents: Record<string, unknown>) {
  return { state: { id: 'proj-id', agents, subscriptions: {} }, repoRoot: '/fake/root' }
}

describe('runStopCommand', () => {
  it('throws when the agent does not exist', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./stop')
    await expect(cmd.run!({ args: { agent: 'ghost' } } as never)).rejects.toThrow('not found')
  })

  it('does not kill a session when the agent is already stopped', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    sessionState.mockResolvedValueOnce('stopped')
    execa.mockClear()
    const { default: cmd } = await import('./stop')
    await cmd.run!({ args: { agent: 'builder' } } as never)
    expect(execa).not.toHaveBeenCalled()
  })

  it('kills the tmux session for a running local agent', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    sessionState.mockResolvedValueOnce('running')
    execa.mockClear()
    const { default: cmd } = await import('./stop')
    await cmd.run!({ args: { agent: 'builder' } } as never)
    const argv = execa.mock.calls[0][1] as string[]
    expect(argv).toContain('kill-session')
  })
})
