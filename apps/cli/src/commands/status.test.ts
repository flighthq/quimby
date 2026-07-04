import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/session', () => ({
  getAgentSessionState: vi.fn(async () => 'stopped'),
}))

const deliverStatusSnapshot = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@quimbyhq/status', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  deliverStatusSnapshot,
}))

let resolved: unknown

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
}))

function workspace(agents: Record<string, unknown>) {
  return { state: { id: 'proj-id', agents }, repoRoot: '/fake/root' }
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
    await expect(cmd.run!({ args: { agent: 'ghost' } } as never)).rejects.toThrow('not found')
  })

  it('pushes a source agent status to a recipient with --to', async () => {
    resolved = workspace({
      builder: { id: 'b1', name: 'builder', location: { type: 'local' } },
      reviewer: { id: 'r1', name: 'reviewer', location: { type: 'local' } },
    })
    deliverStatusSnapshot.mockClear()
    const { default: cmd } = await import('./status')
    await cmd.run!({ args: { agent: 'builder', to: 'reviewer' } } as never)
    expect(deliverStatusSnapshot).toHaveBeenCalledTimes(1)
    expect(deliverStatusSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ fromName: 'builder' }),
    )
  })

  it('errors when --to is given without a source agent', async () => {
    resolved = workspace({ reviewer: { id: 'r1', name: 'reviewer', location: { type: 'local' } } })
    const { default: cmd } = await import('./status')
    await expect(cmd.run!({ args: { to: 'reviewer' } } as never)).rejects.toThrow(/source agent/)
  })

  it('errors when the --to recipient is unknown', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    const { default: cmd } = await import('./status')
    await expect(cmd.run!({ args: { agent: 'builder', to: 'ghost' } } as never)).rejects.toThrow(
      'not found',
    )
  })
})
