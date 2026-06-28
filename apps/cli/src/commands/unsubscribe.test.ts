import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimby/core', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', workers: {}, subscriptions: {} },
    repoRoot: '/fake/root',
  })),
  saveState: vi.fn(),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./unsubscribe')
    expect(typeof cmd.run).toBe('function')
  })

  it('resolves without error when subscription does not exist', async () => {
    const { default: cmd } = await import('./unsubscribe')
    await expect(
      cmd.run!({ args: { worker: 'alice', target: 'bob' } } as never),
    ).resolves.toBeUndefined()
  })
})
