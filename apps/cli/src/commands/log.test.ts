import { describe, expect, it, vi } from 'vitest'

const execa = vi.hoisted(() => vi.fn())
vi.mock('execa', () => ({ execa }))

let resolved: unknown

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
}))

function workspace(agents: Record<string, unknown>) {
  return { state: { id: 'proj-id', agents }, repoRoot: '/fake/root' }
}

describe('runLogCommand', () => {
  it('throws when the agent does not exist', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./log')
    await expect(cmd.run!({ args: { agent: 'ghost' } } as never)).rejects.toThrow('not found')
  })

  it('errors clearly when the agent has no live tmux session', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    execa.mockRejectedValueOnce(new Error("can't find pane: qb-b1"))
    const { default: cmd } = await import('./log')
    await expect(cmd.run!({ args: { agent: 'builder' } } as never)).rejects.toThrow(
      /no live tmux session/,
    )
  })

  it('exposes -f/--follow', async () => {
    const { default: cmd } = await import('./log')
    const flags = cmd.args as Record<string, { type: string; alias?: string }>
    expect(flags.follow).toMatchObject({ type: 'boolean', alias: 'f' })
  })

  it('--follow rejects an SSH agent (its transcript is remote)', async () => {
    resolved = workspace({
      researcher: { id: 'r1', name: 'researcher', location: { type: 'ssh', host: 'user@box' } },
    })
    const { default: cmd } = await import('./log')
    await expect(
      cmd.run!({ args: { agent: 'researcher', follow: true } } as never),
    ).rejects.toThrow(/isn't available for the SSH agent/)
  })

  it('--follow errors when there is no transcript yet', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    const { default: cmd } = await import('./log')
    // /fake/root/.quimby/agents/b1/session.log does not exist, so follow reports it.
    await expect(cmd.run!({ args: { agent: 'builder', follow: true } } as never)).rejects.toThrow(
      /No transcript yet/,
    )
  })
})
