import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', agents: {}, subscriptions: {} },
    repoRoot: '/fake/root',
  })),
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
})
