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
    const { default: cmd } = await import('./assign')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws QuimbyError when agent does not exist', async () => {
    const { default: cmd } = await import('./assign')
    await expect(
      cmd.run!({ args: { name: 'nonexistent', message: 'hello', nudge: false } } as never),
    ).rejects.toThrow('not found')
  })

  it('exposes a --nudge flag to wake a running agent over tmux', async () => {
    const { default: cmd } = await import('./assign')
    const args = cmd.args as Record<string, { type: string; alias?: string }>
    expect(args.nudge).toMatchObject({ type: 'boolean', alias: 'n' })
  })
})
