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
    roles: {
      builder: {
        runtimeProfile: 'sbxClaude',
        runtime: 'sbx',
        entrypoint: 'claude',
        check: { command: 'npm run ci', verifyByDefault: true },
        syncRef: 'origin/main',
        tmux: true,
      },
      reviewer: { runtime: 'local', entrypoint: 'codex' },
      review3: { runtime: 'local', entrypoint: 'codex' },
    },
    hosts: {
      gpu: { host: 'me@gpu' },
    },
    layouts: {
      expanded: 'builder review3 | host $server',
      typo: 'missing',
      roleslot: '@reviewer | host',
      roleundeclared: '@ghostrole',
    },
    presets: {
      loop: {
        agents: {
          builder: { role: 'builder', hostAlias: 'gpu' },
          reviewer: 'reviewer',
        },
      },
      expanded: {
        layout: 'expanded',
        agents: {
          builder: { role: 'builder', hostAlias: 'gpu' },
        },
      },
      typo: {
        layout: 'typo',
      },
      roleslot: {
        layout: 'roleslot',
      },
      rolepreset: {
        layout: 'roleslot',
        agents: {
          reviewer: 'reviewer',
          'reviewer-2': 'reviewer',
        },
      },
      roleundeclared: {
        layout: 'roleundeclared',
      },
    },
    services: { server: 'quimby serve' },
  },
}))
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
}))

vi.mock('@quimbyhq/agent', () => ({ addAgent }))
vi.mock('@quimbyhq/utils', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  logger,
}))
vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  loadState: vi.fn(async () => state.value),
}))

import { createMissingPresetAgents } from './presetAgents'

describe('createMissingPresetAgents', () => {
  it('creates missing agents with resolved role defaults', async () => {
    state.value.agents = {}
    addAgent.mockClear()

    await createMissingPresetAgents('/repo', config.value, 'loop')

    expect(addAgent).toHaveBeenCalledWith('/repo', 'builder', {
      role: 'builder',
      defaults: { runtimeProfile: 'sbxClaude', runtime: 'sbx', entrypoint: 'claude' },
      location: { type: 'ssh', alias: 'gpu' },
      syncRef: 'origin/main',
      tmux: true,
      check: 'npm run ci',
      verifyByDefault: true,
    })
    expect(addAgent).toHaveBeenCalledWith('/repo', 'reviewer', {
      role: 'reviewer',
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
  })

  it('skips agents already present in state', async () => {
    state.value.agents = { builder: { id: 'builder-id', name: 'builder' } }
    addAgent.mockClear()

    await createMissingPresetAgents('/repo', config.value, 'loop')

    expect(addAgent).not.toHaveBeenCalledWith('/repo', 'builder', expect.anything())
    expect(addAgent).toHaveBeenCalledWith('/repo', 'reviewer', {
      role: 'reviewer',
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
    expect(logger.info).toHaveBeenCalledWith('Agent "builder" already exists')
  })

  it('creates missing layout-only agents from same-named roles', async () => {
    state.value.agents = {}
    addAgent.mockClear()

    await createMissingPresetAgents('/repo', config.value, 'expanded')

    expect(addAgent).toHaveBeenCalledWith('/repo', 'builder', {
      role: 'builder',
      defaults: { runtimeProfile: 'sbxClaude', runtime: 'sbx', entrypoint: 'claude' },
      location: { type: 'ssh', alias: 'gpu' },
      syncRef: 'origin/main',
      tmux: true,
      check: 'npm run ci',
      verifyByDefault: true,
    })
    expect(addAgent).toHaveBeenCalledWith('/repo', 'review3', {
      role: 'review3',
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
    expect(addAgent).toHaveBeenCalledTimes(2)
  })

  it('seeds one instance for a @role slot when the preset declares none', async () => {
    state.value.agents = {}
    addAgent.mockClear()

    await createMissingPresetAgents('/repo', config.value, 'roleslot')

    expect(addAgent).toHaveBeenCalledWith('/repo', 'reviewer', {
      role: 'reviewer',
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
    expect(addAgent).toHaveBeenCalledTimes(1)
  })

  it('leaves a @role slot alone when the preset already declares instances of that role', async () => {
    state.value.agents = {}
    addAgent.mockClear()

    await createMissingPresetAgents('/repo', config.value, 'rolepreset')

    // The two explicit reviewer instances satisfy `@reviewer`; no extra `reviewer` is seeded.
    expect(addAgent).toHaveBeenCalledWith('/repo', 'reviewer', expect.objectContaining({ role: 'reviewer' })) // prettier-ignore
    expect(addAgent).toHaveBeenCalledWith('/repo', 'reviewer-2', expect.objectContaining({ role: 'reviewer' })) // prettier-ignore
    expect(addAgent).toHaveBeenCalledTimes(2)
  })

  it('throws when a @role slot names a role not defined under roles:', async () => {
    state.value.agents = {}
    addAgent.mockClear()

    await expect(
      createMissingPresetAgents('/repo', config.value, 'roleundeclared'),
    ).rejects.toThrow('no role "ghostrole" is defined')
    expect(addAgent).not.toHaveBeenCalled()
  })

  it('throws clearly when a layout-only agent cannot be inferred', async () => {
    state.value.agents = {}
    addAgent.mockClear()

    await expect(createMissingPresetAgents('/repo', config.value, 'typo')).rejects.toThrow(
      'layout references agent "missing"',
    )
    expect(addAgent).not.toHaveBeenCalled()
  })
})
