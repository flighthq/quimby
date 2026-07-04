import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  value: {
    id: 'proj',
    agents: {} as Record<string, unknown>,
    subscriptions: {} as Record<string, string[]>,
  },
}))
const addAgent = vi.hoisted(() =>
  vi.fn(async (_repoRoot: string, name: string, opts: object) => {
    state.value.agents[name] = { id: `${name}-id`, name, ...opts }
    return state.value.agents[name]
  }),
)
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
  loadQuimbyConfig: vi.fn(async () => ({
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
    recipes: {
      loop: {
        agents: {
          builder: { role: 'builder', hostAlias: 'gpu' },
          reviewer: 'reviewer',
        },
        subscriptions: {
          reviewer: ['builder'],
        },
      },
    },
  })),
}))

import cmd from './up'

describe('up', () => {
  it('is a function', () => {
    expect(typeof cmd.run).toBe('function')
  })

  it('creates missing agents from recipe roles and subscriptions', async () => {
    state.value.agents = {}
    state.value.subscriptions = {}
    addAgent.mockClear()
    saveState.mockClear()

    await cmd.run!({ args: { recipe: 'loop' } } as never)

    expect(addAgent).toHaveBeenCalledWith('/repo', 'builder', {
      defaults: { runtimeProfile: 'sbxClaude', runtime: 'sbx', entrypoint: 'claude' },
      location: { type: 'ssh', alias: 'gpu' },
      tmux: true,
      check: 'npm run ci',
    })
    expect(addAgent).toHaveBeenCalledWith('/repo', 'reviewer', {
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
    expect(state.value.subscriptions).toEqual({ reviewer: ['builder'] })
    expect(saveState).toHaveBeenCalledWith('/repo', state.value)
  })

  it('skips agents that already exist', async () => {
    state.value.agents = { builder: { id: 'builder-id', name: 'builder' } }
    state.value.subscriptions = {}
    addAgent.mockClear()

    await cmd.run!({ args: { recipe: 'loop' } } as never)

    expect(addAgent).not.toHaveBeenCalledWith('/repo', 'builder', expect.anything())
    expect(addAgent).toHaveBeenCalledWith('/repo', 'reviewer', expect.anything())
  })
})
