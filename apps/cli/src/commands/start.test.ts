import { describe, expect, it, vi } from 'vitest'

const sessionState = vi.hoisted(() => vi.fn(async () => 'stopped'))
const saveState = vi.hoisted(() => vi.fn(async () => {}))
const prepareLocalTmuxLaunch = vi.hoisted(() => vi.fn())
const prepareSshLaunch = vi.hoisted(() => vi.fn())
const execa = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})))
const nudgeAgentSession = vi.hoisted(() => vi.fn(async (_opts: Record<string, unknown>) => {}))
const readAgentStatus = vi.hoisted(() => vi.fn(async () => null as string | null))

// Collapse the resume settle delay so the test isn't slowed by the real 1.5s.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }))
vi.mock('@quimbyhq/agent', () => ({ readAgentStatus }))
vi.mock('execa', () => ({ execa }))
vi.mock('@quimbyhq/session', () => ({ getAgentSessionState: sessionState, nudgeAgentSession }))
vi.mock('@quimbyhq/launch', () => ({
  prepareLocalTmuxLaunch,
  prepareSshLaunch,
  QUIMBY_ROOT_TMUX_FORMAT: '#{?@quimby-root,#{@quimby-root},#{pane_current_path}}',
  QUIMBY_ROOT_TMUX_OPTION: '@quimby-root',
  quimbyRootNewWindowBindingArgs: () => [
    'bind',
    'c',
    'new-window',
    '-c',
    '#{?@quimby-root,#{@quimby-root},#{pane_current_path}}',
  ],
  tmuxSetQuimbyRootShell: (rootCwd: string) =>
    `__quimby_root='${rootCwd}'; tmux set-option @quimby-root "$__quimby_root"; `,
  localNewSessionArgs: (launch: { sessionName: string }, opts: { detached: boolean }) => [
    'new-session',
    '-A',
    ...(opts.detached ? ['-d'] : []),
    '-s',
    launch.sessionName,
  ],
  resolveRuntimeSelection: () => ({ runtime: 'local', entrypoint: 'claude' }),
  launchFingerprint: (sel: { runtime: string; entrypoint: string }) =>
    `${sel.runtime} ${sel.entrypoint}`,
}))

function workspace(agents: Record<string, unknown>) {
  return {
    state: { id: 'proj-id', agents },
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
    await expect(cmd.run!({ args: { agent: 'ghost' } } as never)).rejects.toThrow('not found')
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
    await cmd.run!({ args: { agent: 'builder' } } as never)
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
      rootCwd: '/fake/root',
      envArgs: [],
      shellCmd: 'claude',
      windowName: 'builder',
      runtimeLabel: '',
    })
    const { default: cmd } = await import('./start')
    await cmd.run!({ args: { agent: 'builder' } } as never)

    expect(resolved.state.agents.builder).toMatchObject({ tmux: true })
    expect(saveState).toHaveBeenCalled()
    const argv = execa.mock.calls[0][1] as string[]
    expect(argv).toContain('new-session')
    expect(argv).toContain('-d')
  })

  function localLaunchFixture() {
    prepareLocalTmuxLaunch.mockResolvedValueOnce({
      sessionName: 'qb-b1',
      tmuxConf: '/fake/tmux.conf',
      cwd: '/fake/root',
      rootCwd: '/fake/root',
      envArgs: [],
      shellCmd: 'claude',
      windowName: 'builder',
      runtimeLabel: '',
    })
  }

  it('nudges a fresh agent to resume when status.md carries a predecessor handoff', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    sessionState.mockResolvedValueOnce('stopped')
    readAgentStatus.mockResolvedValueOnce('# left off mid-task')
    nudgeAgentSession.mockClear()
    localLaunchFixture()
    const { default: cmd } = await import('./start')
    await cmd.run!({ args: { agent: 'builder' } } as never)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(1)
    // The resume nudge is a courier notice; nudgeAgentSession prepends the `quimby ·` lead.
    expect((nudgeAgentSession.mock.calls[0][0] as { courier: string }).courier).toBe(
      'resume from @status.md',
    )
  })

  it('does not nudge to resume when status.md is empty/absent', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    sessionState.mockResolvedValueOnce('stopped')
    readAgentStatus.mockResolvedValueOnce(null)
    nudgeAgentSession.mockClear()
    localLaunchFixture()
    const { default: cmd } = await import('./start')
    await cmd.run!({ args: { agent: 'builder' } } as never)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })
})
