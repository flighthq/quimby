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
    const { default: cmd } = await import('./set')
    expect(typeof cmd.run).toBe('function')
  })

  it('does not alias --cmd to -c, keeping -c reserved for --clear', async () => {
    const { default: cmd } = await import('./set')
    expect((cmd.args as Record<string, { alias?: string }>).cmd.alias).toBeUndefined()
  })

  it('throws when agent does not exist', async () => {
    const { default: cmd } = await import('./set')
    await expect(
      cmd.run!({ args: { name: 'nonexistent', runtime: 'local' } } as never),
    ).rejects.toThrow('not found')
  })
})
