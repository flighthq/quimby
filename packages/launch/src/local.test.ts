import type { QuimbyState } from '@quimbyhq/types'
import { describe, expect, it, vi } from 'vitest'

const runSpec = vi.hoisted(() =>
  vi.fn(async () => ({ command: 'sbx', args: ['run', 'claude'], cwd: '/agent/dir', env: {} })),
)
const writeText = vi.hoisted(() => vi.fn(async () => {}))

const setup = vi.hoisted(() => vi.fn(async () => {}))
const configureLocalAgentIdentity = vi.hoisted(() => vi.fn(async () => {}))
const writeAgentInstructions = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@quimbyhq/agent', () => ({ configureLocalAgentIdentity, writeAgentInstructions }))
vi.mock('@quimbyhq/runtimes', () => ({
  runtimeTypes: ['local', 'sbx'],
  runtimeCli: (runtime: string) => (runtime === 'local' ? undefined : runtime),
  getRuntime: () => ({ runSpec, setup }),
  buildContext: (repoRoot: string) => ({ repoRoot }),
  splitCommand: (input: string) => input.trim().split(/\s+/).filter(Boolean),
}))
vi.mock('@quimbyhq/template', () => ({
  renderTmuxConfig: () => 'tmux-conf',
  renderAgentClaudeMd: () => 'claude-md',
}))
vi.mock('@quimbyhq/utils', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  writeText,
}))
vi.mock('@quimbyhq/workspace', () => ({
  loadQuimbyConfig: vi.fn(async () => ({
    runtimeProfiles: {
      ollama: {
        runtime: 'sbx',
        entrypoint: 'codex',
        provider: 'ollama',
        ollama: { host: 'http://gpu:11434' },
      },
    },
  })),
}))

import { localNewSessionArgs, prepareLocalTmuxLaunch } from './local'

function state(): QuimbyState {
  return { id: 'proj', sourceRef: 'main', agents: {} } as QuimbyState
}

const sampleAgent = { id: 'a1', name: 'builder', location: { type: 'local' } } as never

describe('localNewSessionArgs', () => {
  const launch = {
    sessionName: 'qb-proj-a1',
    tmuxConf: '/repo/.quimby/tmux.conf',
    cwd: '/agent/dir',
    rootCwd: '/repo',
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
    expect(launch.rootCwd).toBe('/repo')
    expect(launch.runtimeLabel).toBe(' [sbx]')
    expect(launch.shellCmd).toContain('@quimby-root')
    expect(launch.shellCmd).toContain('rename-window')
    expect(launch.shellCmd).toContain('claude')
    // Starts the durable transcript: the pane pipes its output to session.log.
    expect(launch.shellCmd).toContain('pipe-pane')
    expect(launch.shellCmd).toContain('session.log')
    expect(writeText).toHaveBeenCalledOnce()
    // Identity is re-applied from the host every launch, targeting the agent's own repo clone.
    expect(configureLocalAgentIdentity).toHaveBeenCalledWith(
      '/repo',
      expect.stringContaining('agents/a1/repo'),
      'builder',
    )
    // The Quimby-tier instruction files are refreshed every launch too.
    expect(writeAgentInstructions).toHaveBeenCalledWith(
      expect.stringContaining('agents/a1'),
      expect.objectContaining({ agentName: 'builder', agentId: 'a1' }),
    )
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

  it('applies runtime profile env to the tmux launch', async () => {
    const launch = await prepareLocalTmuxLaunch({
      state: state(),
      repoRoot: '/repo',
      agent: {
        id: 'a1',
        name: 'builder',
        location: { type: 'local' },
        defaults: { runtimeProfile: 'ollama' },
      } as never,
    })
    expect(launch.runtimeLabel).toBe(' [sbx]')
    expect(launch.envArgs).toEqual(expect.arrayContaining(['-e', 'OLLAMA_HOST=http://gpu:11434']))
  })
})
