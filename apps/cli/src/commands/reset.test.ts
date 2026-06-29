import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
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
    const { default: cmd } = await import('./reset')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when worker does not exist', async () => {
    const { default: cmd } = await import('./reset')
    await expect(cmd.run!({ args: { name: 'nonexistent', force: true } } as never)).rejects.toThrow(
      'not found',
    )
  })
})
