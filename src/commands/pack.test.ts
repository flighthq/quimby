import { describe, expect, it, vi } from 'vitest'

vi.mock('../core/workspace', () => ({
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', workers: {}, subscriptions: {} },
    repoRoot: '/fake/root',
  })),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./pack')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when worker does not exist', async () => {
    const { default: cmd } = await import('./pack')
    await expect(cmd.run!({ args: { worker: 'nonexistent' } } as never)).rejects.toThrow(
      'not found',
    )
  })
})
