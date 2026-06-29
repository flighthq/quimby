import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', workers: {}, subscriptions: {} },
    repoRoot: '/fake/root',
  })),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./sync')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when worker does not exist', async () => {
    const { default: cmd } = await import('./sync')
    await expect(cmd.run!({ args: { name: 'nonexistent' } } as never)).rejects.toThrow('not found')
  })
})
