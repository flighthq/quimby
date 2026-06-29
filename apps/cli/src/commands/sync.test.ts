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
    const { default: cmd } = await import('./sync')
    expect(typeof cmd.run).toBe('function')
  })

  it('requires a name or --all', async () => {
    const { default: cmd } = await import('./sync')
    await expect(cmd.run!({ args: { all: false, force: false } } as never)).rejects.toThrow(
      'Specify',
    )
  })

  it('throws when the agent does not exist', async () => {
    const { default: cmd } = await import('./sync')
    await expect(
      cmd.run!({ args: { name: 'ghost', all: false, force: false } } as never),
    ).rejects.toThrow('not found')
  })
})
