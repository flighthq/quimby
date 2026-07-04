import { cloneAndSeedRemoteAgentRepo, writeRemoteAgentScaffold } from '@quimbyhq/agent'
import { collectingReporter } from '@quimbyhq/reporter'
import type { SSHTransport } from '@quimbyhq/transport'
import { getSSHTransport } from '@quimbyhq/transport'
import type { QuimbyState, SSHLocation } from '@quimbyhq/types'
import { saveState } from '@quimbyhq/workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: vi.fn(),
}))
// The remote provisioning primitives are unit-tested in @quimbyhq/agent (and exercised
// end-to-end through rebuildAgent's SSH branch); here we assert prepareSshLaunch invokes
// them correctly rather than re-checking their command strings.
vi.mock('@quimbyhq/agent', () => ({
  cloneAndSeedRemoteAgentRepo: vi.fn(async () => 'seedsha123'),
  writeRemoteAgentScaffold: vi.fn(async () => {}),
  renderRemoteMailboxMigration: vi.fn((rAgentDir: string) => `migrate ${rAgentDir}`),
}))
vi.mock('@quimbyhq/runtimes', () => ({
  runtimeTypes: ['local', 'sbx'],
  runtimeCli: (runtime: string) => (runtime === 'local' ? undefined : runtime),
  getRuntime: () => ({
    runSpec: () => ({ command: 'sbx', args: ['run', 'claude'], cwd: '/agent/dir', env: {} }),
  }),
}))
vi.mock('@quimbyhq/template', () => ({
  renderAgentClaudeMd: () => 'claude-md',
  renderTmuxConfig: () => 'tmux-conf',
}))
vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
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
  saveState: vi.fn(async () => {}),
}))

import { prepareSshLaunch } from './ssh'

const mockedGetSSH = vi.mocked(getSSHTransport)
const mockedClone = vi.mocked(cloneAndSeedRemoteAgentRepo)
const mockedScaffold = vi.mocked(writeRemoteAgentScaffold)
const mockedSaveState = vi.mocked(saveState)

function fakeSSHTransport(repoReady = false): SSHTransport {
  return {
    syncProjectTo: vi.fn(async () => {}),
    fileExists: vi.fn(async (_p: string) => repoReady),
    checkCapabilities: vi.fn(async () => {}),
    ensureDir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    exec: vi.fn(async () => ''),
  } as unknown as SSHTransport
}

function makeState(): QuimbyState {
  return {
    id: 'proj',
    sourceRef: 'main',
    agents: {
      researcher: {
        id: 'r-id',
        name: 'researcher',
        seedCommit: '',
        location: { type: 'ssh', host: 'user@box', base: '~' },
      },
    },
    subscriptions: {},
  } as unknown as QuimbyState
}

function optsFrom(state: QuimbyState) {
  const agent = state.agents.researcher
  return { state, repoRoot: '/repo', agent, location: agent.location as SSHLocation }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('prepareSshLaunch', () => {
  it('rsyncs, then provisions + scaffolds + persists the seed on first launch', async () => {
    const transport = fakeSSHTransport(false)
    mockedGetSSH.mockReturnValue(transport)
    const state = makeState()

    const launch = await prepareSshLaunch(optsFrom(state))

    // Project is rsynced first, then capabilities are checked before init.
    expect(transport.syncProjectTo).toHaveBeenCalledWith('/repo', '~')
    expect(transport.checkCapabilities).toHaveBeenCalledWith(['git', 'rsync', 'tmux'])
    expect(transport.fileExists).toHaveBeenCalledWith('~/.quimby/agents/r-id/repo/.git')

    // Delegates provisioning to the shared primitive with the resolved remote paths.
    expect(mockedClone).toHaveBeenCalledWith(transport, {
      rRoot: '~',
      rRepoDir: '~/.quimby/agents/r-id/repo',
      agentName: 'researcher',
      hostRepoRoot: '/repo',
    })
    // Scaffolds with CLAUDE.md (a first-run agent needs its instructions).
    expect(mockedScaffold).toHaveBeenCalledWith(transport, '~/.quimby/agents/r-id', {
      agentName: 'researcher',
      agentId: 'r-id',
      withClaudeMd: true,
    })

    // The captured seed is persisted through saveState.
    expect(state.agents.researcher.seedCommit).toBe('seedsha123')
    expect(mockedSaveState).toHaveBeenCalledWith('/repo', state)

    // Returned launch fields.
    expect(launch.sessionName).toBe('qb-r-id')
    expect(launch.host).toBe('user@box')
    expect(launch.cwd).toBe('~/.quimby/agents/r-id')
    expect(launch.rootCwd).toBe('~')
    expect(launch.windowName).toBe('researcher')
    expect(launch.runtimeLabel).toBe('')
    expect(launch.shellCmd).toContain('claude')
    expect(launch.transport).toBe(transport)
  })

  it('does not provision, scaffold, or persist when the remote repo already exists', async () => {
    const transport = fakeSSHTransport(true)
    mockedGetSSH.mockReturnValue(transport)
    const state = makeState()

    const launch = await prepareSshLaunch(optsFrom(state))

    // Still rsyncs, but skips the whole init path.
    expect(transport.syncProjectTo).toHaveBeenCalled()
    expect(transport.checkCapabilities).toHaveBeenCalledWith(['tmux'])
    expect(mockedClone).not.toHaveBeenCalled()
    expect(mockedScaffold).not.toHaveBeenCalled()
    expect(mockedSaveState).not.toHaveBeenCalled()

    // Still returns a valid launch spec.
    expect(launch.sessionName).toBe('qb-r-id')
    expect(launch.cwd).toBe('~/.quimby/agents/r-id')
    expect(launch.rootCwd).toBe('~')
    expect(launch.shellCmd).toContain('claude')
  })

  it('builds a shellCmd that records the root cwd before refreshing the window label', async () => {
    mockedGetSSH.mockReturnValue(fakeSSHTransport(false))
    const launch = await prepareSshLaunch(optsFrom(makeState()))
    expect(launch.shellCmd).toContain('@quimby-root')
    expect(launch.shellCmd.indexOf('@quimby-root')).toBeLessThan(
      launch.shellCmd.indexOf('tmux rename-window'),
    )
  })

  it('reports sync and init progress to the reporter on first launch', async () => {
    mockedGetSSH.mockReturnValue(fakeSSHTransport(false))
    const { reporter, events } = collectingReporter()

    await prepareSshLaunch(optsFrom(makeState()), reporter)

    expect(events).toContainEqual({ level: 'start', message: 'Syncing project to user@box...' })
    expect(events).toContainEqual({ level: 'start', message: 'Initializing remote agent...' })
    expect(events).toContainEqual({ level: 'success', message: 'Remote agent initialized' })
  })

  it('checks the selected runtime on the remote host', async () => {
    const transport = fakeSSHTransport(true)
    mockedGetSSH.mockReturnValue(transport)
    const state = makeState()
    state.agents.researcher.defaults = { runtime: 'sbx' }

    await prepareSshLaunch(optsFrom(state))

    expect(transport.checkCapabilities).toHaveBeenCalledWith(['tmux'])
    expect(transport.checkCapabilities).toHaveBeenCalledWith(['sbx'])
  })

  it('checks profile runtime/provider tools and exports profile env in the shell command', async () => {
    const transport = fakeSSHTransport(true)
    mockedGetSSH.mockReturnValue(transport)
    const state = makeState()
    state.agents.researcher.defaults = { runtimeProfile: 'ollama' }

    const launch = await prepareSshLaunch(optsFrom(state))

    expect(transport.checkCapabilities).toHaveBeenCalledWith(['tmux'])
    expect(transport.checkCapabilities).toHaveBeenCalledWith(['sbx', 'ollama'])
    expect(launch.shellCmd).toContain("OLLAMA_HOST='http://gpu:11434'")
  })
})
