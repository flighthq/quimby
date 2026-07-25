import { describe, expect, it, vi } from 'vitest'

const setAgentEnabled = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}))

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

describe('runEnableCommand', () => {
  it('throws when the agent does not exist', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./enable')
    await expect(cmd.run!({ args: { agent: 'ghost' } } as never)).rejects.toThrow('not found')
  })

  it('clears the disabled flag for a disabled agent', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', enabled: false } })
    setAgentEnabled.mockClear()
    const { default: cmd } = await import('./enable')
    await cmd.run!({ args: { agent: 'builder' } } as never)
    expect(setAgentEnabled).toHaveBeenCalledWith('/fake/root', 'builder', true)
  })

  it('no-ops (no state write) when the agent is already enabled', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder' } })
    setAgentEnabled.mockClear()
    const { default: cmd } = await import('./enable')
    await cmd.run!({ args: { agent: 'builder' } } as never)
    expect(setAgentEnabled).not.toHaveBeenCalled()
  })
})
