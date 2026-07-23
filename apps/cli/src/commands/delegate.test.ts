import { afterEach, describe, expect, it, vi } from 'vitest'

const handoffWork = vi.hoisted(() =>
  vi.fn(async () => ({
    from: 'host',
    to: 'builder',
    parcelName: 'host-abc123',
    userDirected: true,
  })),
)
const nudgeAgentSession = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@quimbyhq/handoff', () => ({ handoffWork }))
vi.mock('@quimbyhq/session', () => ({ nudgeAgentSession }))
vi.mock('@quimbyhq/workspace', () => ({
  resolveWorkspace: vi.fn(async () => ({
    state: { agents: { builder: { id: 'b', name: 'builder' } } },
    repoRoot: '/repo',
  })),
}))

afterEach(() => vi.clearAllMocks())

describe('runDelegateCommand', () => {
  it('creates a note-only user-directed parcel and nudges the recipient with its exact name', async () => {
    const { default: command } = await import('./delegate')
    await command.run!({
      args: { agent: 'builder', message: 'review the API', clear: true },
    } as never)

    expect(handoffWork).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'builder',
        message: 'review the API',
        noteOnly: true,
        userDirected: true,
      }),
      expect.anything(),
    )
    expect(nudgeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        clear: true,
        courier: 'delegated task host-abc123 from host',
      }),
    )
  })
})
