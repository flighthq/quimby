import { describe, expect, it, vi } from 'vitest'

const sessionState = vi.hoisted(() => vi.fn(async () => 'stopped'))
const saveState = vi.hoisted(() => vi.fn(async () => {}))
const prepareLocalTmuxLaunch = vi.hoisted(() => vi.fn())
const prepareSshLaunch = vi.hoisted(() => vi.fn())
const execa = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})))

vi.mock('execa', () => ({ execa }))
vi.mock('@quimbyhq/session', () => ({ getAgentSessionState: sessionState }))
vi.mock('@quimbyhq/launch', () => ({
  prepareLocalTmuxLaunch,
  prepareSshLaunch,
  localNewSessionArgs: (launch: { sessionName: string }, opts: { detached: boolean }) => [
    'new-session',
    '-A',
    ...(opts.detached ? ['-d'] : []),
    '-s',
    launch.sessionName,
  ],
}))

function workspace(agents: Record<string, unknown>) {
  return {
    state: { id: 'proj-id', agents, subscriptions: {} },
    repoRoot: '/fake/root',
  }
}

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
  saveState,
}))

let resolved: ReturnType<typeof workspace>

describe('runStartCommand', () => {
  it('throws when the agent does not exist', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./start')
    await expect(cmd.run!({ args: { name: 'ghost' } } as never)).rejects.toThrow('not found')
  })

  it('does not alias --cmd to -c, keeping -c reserved for --clear', async () => {
    const { default: cmd } = await import('./start')
    expect((cmd.args as Record<string, { alias?: string }>).cmd.alias).toBeUndefined()
  })

  it('no-ops when the agent is already running', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    sessionState.mockResolvedValueOnce('running')
    prepareLocalTmuxLaunch.mockClear()
    const { default: cmd } = await import('./start')
    await cmd.run!({ args: { name: 'builder' } } as never)
    expect(prepareLocalTmuxLaunch).not.toHaveBeenCalled()
  })

  it('auto-enables tmux and launches a detached session for a local agent', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    sessionState.mockResolvedValueOnce('stopped')
    saveState.mockClear()
    execa.mockClear()
    prepareLocalTmuxLaunch.mockResolvedValueOnce({
      sessionName: 'qb-b1',
      tmuxConf: '/fake/tmux.conf',
      cwd: '/fake/root',
      envArgs: [],
      shellCmd: 'claude',
      windowName: 'builder',
      runtimeLabel: '',
    })
    const { default: cmd } = await import('./start')
    await cmd.run!({ args: { name: 'builder' } } as never)

    expect(resolved.state.agents.builder).toMatchObject({ tmux: true })
    expect(saveState).toHaveBeenCalled()
    const argv = execa.mock.calls[0][1] as string[]
    expect(argv).toContain('new-session')
    expect(argv).toContain('-d')
  })
})
