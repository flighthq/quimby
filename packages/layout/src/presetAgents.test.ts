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
      fleet: {
        agents: {
          builder: { role: 'builder', count: 3 },
        },
      },
      mixedfleet: {
        agents: {
          builder: { role: 'builder', count: 2 },
          'builder-fast': { role: 'builder', runtimeProfile: 'codex-sbx', count: 1 },
        },
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

import { createMissingPresetAgents, replicaNames } from './presetAgents'

describe('createMissingPresetAgents', () => {
  it('expands a count into replica agents named base, base-2, base-3', async () => {
    state.value.agents = {}
    addAgent.mockClear()

    await createMissingPresetAgents('/repo', config.value, 'fleet')

    const created = addAgent.mock.calls.map((c) => c[1])
    expect(created).toEqual(['builder', 'builder-2', 'builder-3'])
  })

  it('carries an entry profile override onto every replica as a pin', async () => {
    state.value.agents = {}
    addAgent.mockClear()

    await createMissingPresetAgents('/repo', config.value, 'mixedfleet')

    const created = addAgent.mock.calls.map((c) => c[1])
    expect(created).toEqual(['builder', 'builder-2', 'builder-fast'])
    // The plain builders inherit the role engine (no pin); builder-fast pins the override.
    expect(addAgent).toHaveBeenCalledWith(
      '/repo',
      'builder-fast',
      expect.objectContaining({ role: 'builder', runtimeProfile: 'codex-sbx' }),
    )
    expect(addAgent).toHaveBeenCalledWith(
      '/repo',
      'builder',
      expect.not.objectContaining({ runtimeProfile: expect.anything() }),
    )
  })

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

describe('replicaNames', () => {
  it('names the first replica bare and the rest -N, from 2', () => {
    expect(replicaNames('builder', 3)).toEqual(['builder', 'builder-2', 'builder-3'])
  })

  it('treats a count of 1 or less as a single bare instance', () => {
    expect(replicaNames('builder', 1)).toEqual(['builder'])
    expect(replicaNames('builder', 0)).toEqual(['builder'])
  })
})
