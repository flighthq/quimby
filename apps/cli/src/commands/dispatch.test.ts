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
    const { default: cmd } = await import('./dispatch')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when the agent does not exist', async () => {
    const { default: cmd } = await import('./dispatch')
    await expect(
      cmd.run!({
        args: { agent: 'ghost', all: false, rebase: false, nudge: true },
      } as never),
    ).rejects.toThrow('not found')
  })

  it('throws when neither an agent nor --all is given', async () => {
    const { default: cmd } = await import('./dispatch')
    await expect(
      cmd.run!({ args: { all: false, rebase: false, nudge: true } } as never),
    ).rejects.toThrow('--all')
  })

  it('with --all and no agents, reports nothing to do instead of throwing', async () => {
    const { default: cmd } = await import('./dispatch')
    await expect(
      cmd.run!({ args: { all: true, rebase: false, nudge: true } } as never),
    ).resolves.toBeUndefined()
  })

  it('exposes an --all flag to dispatch every outbox', async () => {
    const { default: cmd } = await import('./dispatch')
    const args = cmd.args as Record<string, { type: string; default?: boolean }>
    expect(args.all).toMatchObject({ type: 'boolean', default: false })
  })

  it('nudges running recipients over tmux by default (--no-nudge to skip)', async () => {
    const { default: cmd } = await import('./dispatch')
    const args = cmd.args as Record<string, { type: string; default?: boolean }>
    expect(args.nudge).toMatchObject({ type: 'boolean', default: true })
  })
})
