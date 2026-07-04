import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  value: {
    id: 'proj',
    agents: {} as Record<string, unknown>,
  },
}))
const addAgent = vi.hoisted(() =>
  vi.fn(async (_repoRoot: string, name: string, opts: object) => {
    state.value.agents[name] = { id: `${name}-id`, name, ...opts }
    return state.value.agents[name]
  }),
)
const config = vi.hoisted(() => ({
  value: {
    default: 'loop' as string | undefined,
    roles: {
      builder: {
        runtimeProfile: 'sbxClaude',
        runtime: 'sbx',
        entrypoint: 'claude',
        check: { command: 'npm run ci' },
        tmux: true,
      },
      reviewer: { runtime: 'local', entrypoint: 'codex' },
    },
    hosts: {
      gpu: { host: 'me@gpu' },
    },
    presets: {
      loop: {
        agents: {
          builder: { role: 'builder', hostAlias: 'gpu' },
          reviewer: 'reviewer',
        },
      },
      small: {
        agents: {
          reviewer: 'reviewer',
        },
      },
    },
  },
}))
const saveState = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@quimbyhq/git', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  findRoot: vi.fn(async () => '/repo'),
}))
vi.mock('@quimbyhq/agent', () => ({ addAgent }))
vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  ensureWorkspace: vi.fn(async () => state.value),
  loadState: vi.fn(async () => state.value),
  saveState,
  loadQuimbyConfig: vi.fn(async () => config.value),
}))

import cmd from './up'

describe('runUpCommand', () => {
  it('is a function', () => {
    expect(typeof cmd.run).toBe('function')
  })

  it('creates missing agents from the default preset with --default', async () => {
    state.value.agents = {}
    config.value.default = 'small'
    addAgent.mockClear()

    await cmd.run!({ args: { default: true } } as never)

    expect(addAgent).toHaveBeenCalledTimes(1)
    expect(addAgent).toHaveBeenCalledWith('/repo', 'reviewer', {
      role: 'reviewer',
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
  })

  it('creates missing agents from the default preset with no arguments', async () => {
    state.value.agents = {}
    config.value.default = 'small'
    addAgent.mockClear()

    await cmd.run!({ args: {} } as never)

    expect(addAgent).toHaveBeenCalledTimes(1)
    expect(addAgent).toHaveBeenCalledWith('/repo', 'reviewer', {
      role: 'reviewer',
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
  })

  it('creates missing agents from preset roles', async () => {
    state.value.agents = {}
    config.value.default = 'small'
    addAgent.mockClear()

    await cmd.run!({ args: { preset: 'loop' } } as never)

    expect(addAgent).toHaveBeenCalledWith('/repo', 'builder', {
      role: 'builder',
      defaults: { runtimeProfile: 'sbxClaude', runtime: 'sbx', entrypoint: 'claude' },
      location: { type: 'ssh', alias: 'gpu' },
      tmux: true,
      check: 'npm run ci',
    })
    expect(addAgent).toHaveBeenCalledWith('/repo', 'reviewer', {
      role: 'reviewer',
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
  })

  it('skips agents that already exist', async () => {
    state.value.agents = { builder: { id: 'builder-id', name: 'builder' } }
    config.value.default = 'loop'
    addAgent.mockClear()

    await cmd.run!({ args: { preset: 'loop' } } as never)

    expect(addAgent).not.toHaveBeenCalledWith('/repo', 'builder', expect.anything())
    expect(addAgent).toHaveBeenCalledWith('/repo', 'reviewer', expect.anything())
  })

  it('throws clearly when a preset and --default are both provided', async () => {
    state.value.agents = {}
    config.value.default = 'small'

    await expect(cmd.run!({ args: { preset: 'loop', default: true } } as never)).rejects.toThrow(
      'Choose either a preset name or --default',
    )
  })

  it('throws clearly when no preset or default is configured', async () => {
    state.value.agents = {}
    config.value.default = undefined

    await expect(cmd.run!({ args: {} } as never)).rejects.toThrow(
      'Provide a preset name or configure a default preset',
    )
  })
})
