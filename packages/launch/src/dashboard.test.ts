import type { QuimbyState } from '@quimbyhq/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/runtimes', () => ({
  runtimeTypes: ['local', 'sbx'],
  getRuntime: () => ({
    runSpec: () => ({ command: 'claude', args: ['claude'], cwd: '/agent/dir', env: {} }),
  }),
  buildContext: (repoRoot: string) => ({ repoRoot }),
}))
vi.mock('./ssh', () => ({
  prepareSshLaunch: vi.fn(async () => ({
    transport: {},
    host: 'gpu-box',
    sessionName: 'qb-proj-r1',
    tmuxConf: '/remote/tmux.conf',
    cwd: '/remote/agent',
    shellCmd: 'claude',
    windowName: 'researcher',
    runtimeLabel: '',
  })),
}))

import { buildDashboardPlan, buildDashboardWindows, HOST_WINDOW } from './dashboard'
import { prepareSshLaunch } from './ssh'

const mockedSshLaunch = vi.mocked(prepareSshLaunch)

function stateWith(agents: Record<string, { location: unknown }>): QuimbyState {
  const built: Record<string, unknown> = {}
  for (const [name, a] of Object.entries(agents)) built[name] = { id: `${name}-id`, name, ...a }
  return {
    id: 'proj',
    sourceRef: 'main',
    agents: built,
    subscriptions: {},
  } as unknown as QuimbyState
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildDashboardPlan', () => {
  const windows = [
    { name: 'host', cwd: '/repo', cmd: ['bash', '-l'] },
    {
      name: 'builder',
      cwd: '/agent',
      cmd: ['bash', '-l', '-c', 'claude'],
      env: [['K', 'v']] as [string, string][],
    },
  ]

  it('creates the session detached with the first window, then adds the rest', () => {
    const { commands } = buildDashboardPlan('dash', '/tmux.conf', windows)
    expect(commands[0]).toEqual(
      expect.arrayContaining(['-f', '/tmux.conf', 'new-session', '-d', '-s', 'dash', '-n', 'host']),
    )
    expect(commands[1]).toEqual(
      expect.arrayContaining(['new-window', '-t', 'dash', '-n', 'builder', '-e', 'K=v']),
    )
  })

  it('sets activity/silence monitoring and the tab-status formats', () => {
    const flat = buildDashboardPlan('dash', '/c', windows)
      .commands.map((c) => c.join(' '))
      .join('\n')
    expect(flat).toContain('set-option -t dash monitor-activity on')
    expect(flat).toContain('set-option -t dash monitor-silence 30')
    expect(flat).toContain('window-status-format')
    expect(flat).toContain('window-status-current-format')
  })

  it('ends with a select-window and returns the attach invocation', () => {
    const { commands, attach } = buildDashboardPlan('dash', '/c', windows)
    expect(commands.at(-1)).toEqual(expect.arrayContaining(['select-window', '-t', 'dash:0']))
    expect(attach).toEqual(['-L', 'quimby', 'attach', '-t', 'dash'])
  })
})

describe('buildDashboardWindows', () => {
  it('throws for an unknown, non-host agent name', async () => {
    await expect(buildDashboardWindows(stateWith({}), '/repo', ['ghost'])).rejects.toThrow(
      'not found',
    )
  })

  it('adds a login-shell window for the reserved host name', async () => {
    const windows = await buildDashboardWindows(stateWith({}), '/repo', [HOST_WINDOW])
    expect(windows).toEqual([{ name: 'host', cwd: '/repo', cmd: ['bash', '-l'] }])
  })

  it('builds a local window that runs the entrypoint and holds the pane open on failure', async () => {
    const [window] = await buildDashboardWindows(
      stateWith({ builder: { location: { type: 'local' } } }),
      '/repo',
      ['builder'],
    )
    expect(window.name).toBe('builder')
    expect(window.cmd[0]).toBe('bash')
    expect(window.cmd.at(-1)).toContain('press Enter to close')
  })

  it('builds an SSH window via prepareSshLaunch rather than re-implementing remote init', async () => {
    const [window] = await buildDashboardWindows(
      stateWith({
        researcher: { location: { type: 'ssh', host: 'gpu-box', base: '~', port: 2222 } },
      }),
      '/repo',
      ['researcher'],
    )
    expect(mockedSshLaunch).toHaveBeenCalledOnce()
    expect(window.cmd.slice(0, 5)).toEqual(['ssh', '-t', '-p', '2222', 'gpu-box'])
    expect(window.cmd.at(-1)).toContain('new-session')
  })
})
