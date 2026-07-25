import { describe, expect, it, vi } from 'vitest'

const sessionState = vi.hoisted(() => vi.fn(async () => 'stopped'))
const execa = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})))
const setAgentEnabled = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}))

vi.mock('execa', () => ({ execa }))
vi.mock('@quimbyhq/session', () => ({ getAgentSessionState: sessionState }))
vi.mock('@quimbyhq/agent', () => ({ setAgentEnabled }))

let resolved: {
  state: { id: string; agents: Record<string, unknown> }
  repoRoot: string
}

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
}))

function workspace(agents: Record<string, unknown>) {
  return { state: { id: 'proj-id', agents }, repoRoot: '/fake/root' }
}

describe('runDisableCommand', () => {
  it('throws when the agent does not exist', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./disable')
    await expect(cmd.run!({ args: { agent: 'ghost' } } as never)).rejects.toThrow('not found')
  })

  it('frees a running session and persists the disabled flag', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    sessionState.mockResolvedValueOnce('running')
    execa.mockClear()
    setAgentEnabled.mockClear()
    const { default: cmd } = await import('./disable')
    await cmd.run!({ args: { agent: 'builder' } } as never)
    expect((execa.mock.calls[0][1] as string[]) ?? []).toContain('kill-session')
    expect(setAgentEnabled).toHaveBeenCalledWith('/fake/root', 'builder', false)
  })

  it('still disables an already-stopped agent without killing a session', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    sessionState.mockResolvedValueOnce('stopped')
    execa.mockClear()
    setAgentEnabled.mockClear()
    const { default: cmd } = await import('./disable')
    await cmd.run!({ args: { agent: 'builder' } } as never)
    expect(execa).not.toHaveBeenCalled()
    expect(setAgentEnabled).toHaveBeenCalledWith('/fake/root', 'builder', false)
  })
})
