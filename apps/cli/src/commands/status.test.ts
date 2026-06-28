import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimby/core', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', workers: {}, subscriptions: {} },
    repoRoot: '/fake/root',
  })),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./status')
    expect(typeof cmd.run).toBe('function')
  })

  it('resolves (logs info) when there are no workers', async () => {
    const { default: cmd } = await import('./status')
    await expect(cmd.run!({ args: {} } as never)).resolves.toBeUndefined()
  })
})
