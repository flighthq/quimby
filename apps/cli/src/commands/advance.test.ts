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
    const { default: cmd } = await import('./advance')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when no name and no --all', async () => {
    const { default: cmd } = await import('./advance')
    await expect(cmd.run!({ args: { all: false } } as never)).rejects.toThrow(
      'Specify one or more worker names',
    )
  })

  it('throws when an explicit worker does not exist', async () => {
    const { default: cmd } = await import('./advance')
    await expect(cmd.run!({ args: { name: 'nonexistent', all: false } } as never)).rejects.toThrow(
      'not found',
    )
  })
})
