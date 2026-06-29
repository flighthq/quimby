import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', agents: {}, subscriptions: {} },
    repoRoot: '/fake/root',
  })),
  saveState: vi.fn(),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./subscribe')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when subscribing agent does not exist', async () => {
    const { default: cmd } = await import('./subscribe')
    await expect(
      cmd.run!({ args: { agent: 'nonexistent', target: 'other' } } as never),
    ).rejects.toThrow('not found')
  })
})
