import type { QuimbyState } from '@quimbyhq/types'
import { describe, expect, it, vi } from 'vitest'

const runSpec = vi.hoisted(() =>
  vi.fn(async () => ({ command: 'sbx', args: ['run', 'claude'], cwd: '/agent/dir', env: {} })),
)
const writeText = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@quimbyhq/runtimes', () => ({
  runtimeTypes: ['local', 'sbx'],
  getRuntime: () => ({ runSpec }),
  buildContext: (repoRoot: string) => ({ repoRoot }),
}))
vi.mock('@quimbyhq/template', () => ({
  renderTmuxConfig: () => 'tmux-conf',
  renderAgentClaudeMd: () => 'claude-md',
}))
vi.mock('@quimbyhq/utils', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  writeText,
}))

import { localNewSessionArgs, prepareLocalTmuxLaunch } from './local'

function state(): QuimbyState {
  return { id: 'proj', sourceRef: 'main', agents: {}, subscriptions: {} } as QuimbyState
}

const sampleAgent = { id: 'a1', name: 'builder', location: { type: 'local' } } as never

describe('localNewSessionArgs', () => {
  const launch = {
    sessionName: 'qb-proj-a1',
    tmuxConf: '/repo/.quimby/tmux.conf',
    cwd: '/agent/dir',
    envArgs: ['-e', 'FOO=bar'],
    shellCmd: 'run claude',
    windowName: 'builder',
    runtimeLabel: '',
  }

  it('builds an attach invocation (-A, no -d) for run', () => {
    const args = localNewSessionArgs(launch, { detached: false })
    expect(args).toContain('-A')
    expect(args).not.toContain('-d')
    expect(args.slice(0, 2)).toEqual(['-L', 'quimby'])
    expect(args).toEqual(
      expect.arrayContaining(['-s', 'qb-proj-a1', '-n', 'builder', '-c', '/agent/dir']),
    )
    expect(args.at(-1)).toBe('run claude')
  })

  it('adds -d for a detached (headless) start, right after -A', () => {
    const args = localNewSessionArgs(launch, { detached: true })
    const at = args.indexOf('-A')
    expect(args[at + 1]).toBe('-d')
  })

  it('threads env args through as -e pairs', () => {
    const args = localNewSessionArgs(launch, { detached: false })
    expect(args).toEqual(expect.arrayContaining(['-e', 'FOO=bar']))
  })
})

describe('prepareLocalTmuxLaunch', () => {
  it('builds a shell command with the entrypoint quoted and writes the tmux config', async () => {
    writeText.mockClear()
    const launch = await prepareLocalTmuxLaunch({
      state: state(),
      repoRoot: '/repo',
      agent: sampleAgent,
      runtime: 'sbx',
    })

    expect(launch.sessionName).toContain('qb-')
    expect(launch.windowName).toBe('builder')
    expect(launch.runtimeLabel).toBe(' [sbx]')
    expect(launch.shellCmd).toContain('rename-window')
    expect(launch.shellCmd).toContain('claude')
    // Starts the durable transcript: the pane pipes its output to session.log.
    expect(launch.shellCmd).toContain('pipe-pane')
    expect(launch.shellCmd).toContain('session.log')
    expect(writeText).toHaveBeenCalledOnce()
  })

  it('rejects an unknown runtime', async () => {
    await expect(
      prepareLocalTmuxLaunch({
        state: state(),
        repoRoot: '/repo',
        agent: sampleAgent,
        runtime: 'bogus',
      }),
    ).rejects.toThrow('Unknown runtime')
  })
})
