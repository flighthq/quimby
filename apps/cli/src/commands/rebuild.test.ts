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
    const { default: cmd } = await import('./rebuild')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when the agent does not exist', async () => {
    const { default: cmd } = await import('./rebuild')
    await expect(cmd.run!({ args: { name: 'ghost', force: true } } as never)).rejects.toThrow(
      'not found',
    )
  })
})
