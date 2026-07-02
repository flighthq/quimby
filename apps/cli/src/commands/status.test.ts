import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/session', () => ({
  getAgentSessionState: vi.fn(async () => 'stopped'),
}))

let resolved: unknown

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
}))

function workspace(agents: Record<string, unknown>) {
  return { state: { id: 'proj-id', agents, subscriptions: {} }, repoRoot: '/fake/root' }
}

describe('runStatusCommand', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./status')
    expect(typeof cmd.run).toBe('function')
  })

  it('logs info and resolves when there are no agents', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./status')
    await expect(cmd.run!({ args: {} } as never)).resolves.toBeUndefined()
  })

  it('renders an overview across all agents', async () => {
    resolved = workspace({
      builder: { id: 'b1', name: 'builder', seedCommit: 'abc1234', location: { type: 'local' } },
    })
    const { default: cmd } = await import('./status')
    await expect(cmd.run!({ args: {} } as never)).resolves.toBeUndefined()
  })

  it('throws QuimbyError for an unknown agent in the deep-dive', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./status')
    await expect(cmd.run!({ args: { name: 'ghost' } } as never)).rejects.toThrow('not found')
  })
})
