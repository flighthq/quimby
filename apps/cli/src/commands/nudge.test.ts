import { describe, expect, it, vi } from 'vitest'

const nudgeAgentSession = vi.hoisted(() => vi.fn(async (_opts: { text: string }) => {}))
const hasAgentSession = vi.hoisted(() => vi.fn(async () => true))

vi.mock('@quimbyhq/session', () => ({ nudgeAgentSession, hasAgentSession }))

let resolved = { state: { id: 'proj-id', agents: {}, subscriptions: {} }, repoRoot: '/fake/root' }

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./nudge')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when the agent does not exist', async () => {
    const { default: cmd } = await import('./nudge')
    await expect(cmd.run!({ args: { agent: 'ghost', all: false } } as never)).rejects.toThrow(
      'not found',
    )
  })

  it('throws when neither an agent nor --all is given', async () => {
    const { default: cmd } = await import('./nudge')
    await expect(cmd.run!({ args: { all: false } } as never)).rejects.toThrow('--all')
  })

  it('with --all and no agents, reports nothing to do instead of throwing', async () => {
    const { default: cmd } = await import('./nudge')
    await expect(cmd.run!({ args: { all: true } } as never)).resolves.toBeUndefined()
  })

  it('--verify types the canned self-verify request naming the agent check', async () => {
    resolved = {
      state: {
        id: 'proj-id',
        agents: { builder: { id: 'b1', name: 'builder', tmux: true, check: 'npm run ci' } },
        subscriptions: {},
      },
      repoRoot: '/fake/root',
    } as never
    nudgeAgentSession.mockClear()
    const { default: cmd } = await import('./nudge')
    await cmd.run!({ args: { agent: 'builder', all: false, verify: true } } as never)
    const { text } = nudgeAgentSession.mock.calls[0][0]
    expect(text).toContain('npm run ci')
    expect(text).toContain('quimby-attest')
  })
})
