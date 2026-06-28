import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/core', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', workers: {}, subscriptions: {} },
    repoRoot: '/fake/root',
  })),
  loadState: vi.fn(async () => ({ id: 'proj-id', workers: {}, subscriptions: {} })),
  saveState: vi.fn(),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./rename')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when worker does not exist', async () => {
    const { default: cmd } = await import('./rename')
    await expect(
      cmd.run!({ args: { name: 'nonexistent', newName: 'bob' } } as never),
    ).rejects.toThrow()
  })
})
