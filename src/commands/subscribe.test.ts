import { describe, expect, it, vi } from 'vitest'

vi.mock('../core/workspace', () => ({
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', workers: {}, subscriptions: {} },
    repoRoot: '/fake/root',
  })),
  saveState: vi.fn(),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./subscribe')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when subscribing worker does not exist', async () => {
    const { default: cmd } = await import('./subscribe')
    await expect(
      cmd.run!({ args: { worker: 'nonexistent', target: 'other' } } as never),
    ).rejects.toThrow('not found')
  })
})
