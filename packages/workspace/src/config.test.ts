import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { getLocalConfigPath, getProjectConfigPath } from '@quimbyhq/paths'
import { writeYaml } from '@quimbyhq/utils'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'

import {
  isHostAliasBound,
  loadQuimbyConfig,
  mergeConfigs,
  normalizeCheck,
  resolveAgentRoleConfig,
  resolveBoundHostAlias,
  resolveConfiguredAgent,
  resolveHostAlias,
  resolveLayoutExpr,
  resolveRecipe,
  resolveRecipeLayout,
  resolveRole,
  resolveSSHConnection,
  saveHostAliasBinding,
} from './config'

const config = {
  defaults: {
    runtime: 'local',
    entrypoint: 'claude',
    check: { command: 'npm test', verifyByDefault: false },
  },
  roles: {
    builder: {
      runtimeProfile: 'sbxClaude',
      runtime: 'sbx',
      check: { command: 'npm run ci' },
      tmux: true,
    },
    reviewer: {
      entrypoint: 'codex --model "gpt 5"',
      check: 'npm run lint',
    },
  },
  runtimeProfiles: {
    sbxClaude: { runtime: 'sbx', entrypoint: 'claude' },
    openshellOllama: {
      runtime: 'openshell',
      entrypoint: 'codex',
      provider: 'ollama',
      ollama: { host: 'http://gpu:11434' },
    },
  },
  layouts: {
    review: 'reviewer | (builder integration) / ($ $):30',
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
      layout: 'review',
    },
  },
  hosts: {
    gpu: { type: 'ssh' as const, host: 'me@gpu', port: 2222, base: '/srv/quimby' },
  },
}

describe('isHostAliasBound', () => {
  it('treats a real address as bound', () => {
    expect(isHostAliasBound({ host: 'me@box' }, 'remote')).toBe(true)
  })

  it('treats absent, empty, or self-referential host as unbound', () => {
    expect(isHostAliasBound(undefined, 'remote')).toBe(false)
    expect(isHostAliasBound({ host: '' }, 'remote')).toBe(false)
    expect(isHostAliasBound({ host: 'remote' }, 'remote')).toBe(false)
  })
})

describe('loadQuimbyConfig', () => {
  it('loads ignored project-local config over tracked project config', async () => {
    const dir = join(tmpdir(), `quimby-config-${crypto.randomUUID()}`)
    try {
      await mkdir(join(dir, '.quimby'), { recursive: true })
      await writeYaml(getProjectConfigPath(dir), {
        roles: {
          builder: { runtimeProfile: 'tracked-profile' },
        },
        runtimeProfiles: {
          'tracked-profile': { runtime: 'sbx', entrypoint: 'claude' },
          local: { runtime: 'local', entrypoint: 'claude' },
        },
      })
      await writeYaml(getLocalConfigPath(dir), {
        roles: {
          builder: { runtimeProfile: 'local-profile' },
          reviewer: { runtimeProfile: 'local-profile' },
        },
        runtimeProfiles: {
          'local-profile': {
            runtime: 'openshell',
            entrypoint: 'codex',
            provider: 'ollama',
            ollama: { host: 'http://localhost:11434' },
          },
        },
      })

      const loaded = await loadQuimbyConfig(dir)

      expect(resolveRole(loaded, 'builder').runtimeProfile).toBe('local-profile')
      expect(resolveRole(loaded, 'reviewer').runtimeProfile).toBe('local-profile')
      expect(loaded.runtimeProfiles?.['tracked-profile']).toMatchObject({ runtime: 'sbx' })
      expect(loaded.runtimeProfiles?.['local-profile']).toMatchObject({
        runtime: 'openshell',
        ollama: { host: 'http://localhost:11434' },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('mergeConfigs', () => {
  it('layers runtime profile machine settings without replacing tracked launch defaults', () => {
    expect(
      mergeConfigs(
        {
          runtimeProfiles: {
            ollama: {
              runtime: 'openshell',
              entrypoint: 'codex',
              provider: 'ollama',
              env: { CODEX_HOME: '~/.codex' },
            },
          },
        },
        {
          runtimeProfiles: {
            ollama: {
              ollama: { host: 'http://gpu:11434' },
              env: { CODEX_HOME: '/srv/codex', EXTRA: '1' },
              requiredTools: ['codex'],
            },
          },
        },
      ).runtimeProfiles?.ollama,
    ).toEqual({
      runtime: 'openshell',
      entrypoint: 'codex',
      provider: 'ollama',
      env: { CODEX_HOME: '/srv/codex', EXTRA: '1' },
      ollama: { host: 'http://gpu:11434' },
      requiredTools: ['codex'],
      permissions: undefined,
    })
  })
})

describe('quimby config helpers', () => {
  it('merges defaults into a role and lets the role override fields', () => {
    expect(resolveRole(config, 'builder')).toMatchObject({
      runtime: 'sbx',
      runtimeProfile: 'sbxClaude',
      entrypoint: 'claude',
      check: { command: 'npm run ci', verifyByDefault: false },
      tmux: true,
    })
  })

  it('normalizes a string check into a check object', () => {
    expect(normalizeCheck(resolveRole(config, 'reviewer').check)).toEqual({
      command: 'npm run lint',
    })
  })

  it('resolves configured-agent shorthand to a role reference', () => {
    expect(resolveConfiguredAgent(config, 'builder')).toEqual({ role: 'builder' })
  })

  it('resolves agent config as defaults + role + per-agent overrides', () => {
    expect(
      resolveAgentRoleConfig(config, {
        role: 'builder',
        runtime: 'local',
        runtimeProfile: 'sbxClaude',
        check: { verifyByDefault: true },
      }),
    ).toMatchObject({
      runtime: 'local',
      entrypoint: 'claude',
      check: { command: 'npm run ci', verifyByDefault: true },
    })
  })

  it('resolves layouts directly and through a recipe', () => {
    expect(resolveLayoutExpr(config, 'review')).toBe('reviewer | (builder integration) / ($ $):30')
    expect(resolveRecipeLayout(config, 'loop')).toBe('reviewer | (builder integration) / ($ $):30')
  })

  it('returns raw expressions when no saved layout exists', () => {
    expect(resolveLayoutExpr(config, 'a | b')).toBe('a | b')
  })

  it('resolves recipes and host aliases', () => {
    expect(resolveRecipe(config, 'loop').subscriptions?.reviewer).toEqual(['builder'])
    expect(resolveHostAlias(config, 'gpu')).toMatchObject({ host: 'me@gpu', port: 2222 })
  })

  it('throws for missing roles, recipes, and host aliases', () => {
    expect(() => resolveRole(config, 'missing')).toThrow('Role "missing" not found')
    expect(() => resolveRecipe(config, 'missing')).toThrow('Recipe "missing" not found')
    expect(() => resolveHostAlias(config, 'missing')).toThrow('Host alias "missing" not found')
  })
})

describe('resolveBoundHostAlias', () => {
  it('returns the binding when an alias has a real address', () => {
    const cfg = { hosts: { gpu: { host: 'me@gpu', port: 2222, base: '/srv' } } }
    expect(resolveBoundHostAlias(cfg, 'gpu')).toEqual({ host: 'me@gpu', port: 2222, base: '/srv' })
  })

  it('returns null for an unbound or undeclared alias', () => {
    expect(resolveBoundHostAlias({ hosts: { remote: { host: 'remote' } } }, 'remote')).toBeNull()
    expect(resolveBoundHostAlias({}, 'remote')).toBeNull()
  })
})

describe('resolveSSHConnection', () => {
  it('binds an explicit alias to its private address', () => {
    const cfg = { hosts: { remote: { host: 'me@box', base: '/srv' } } }
    expect(resolveSSHConnection(cfg, { type: 'ssh', alias: 'remote' })).toEqual({
      location: { type: 'ssh', host: 'me@box', alias: 'remote', base: '/srv' },
    })
  })

  it('treats a legacy host that names a declared alias as that alias', () => {
    const cfg = { hosts: { remote: { host: 'me@box' } } }
    expect(resolveSSHConnection(cfg, { type: 'ssh', host: 'remote' })).toEqual({
      location: { type: 'ssh', host: 'me@box', alias: 'remote' },
    })
  })

  it('passes a concrete host through unchanged', () => {
    expect(resolveSSHConnection({}, { type: 'ssh', host: 'me@box', port: 22 })).toEqual({
      location: { type: 'ssh', host: 'me@box', port: 22 },
    })
  })

  it('reports an unbound alias for the caller to prompt on', () => {
    const cfg = { hosts: { remote: { host: 'remote' } } }
    expect(resolveSSHConnection(cfg, { type: 'ssh', alias: 'remote', base: '/srv' })).toEqual({
      unboundAlias: 'remote',
      base: '/srv',
    })
  })

  it('prefers a location override over the alias binding for port and base', () => {
    const cfg = { hosts: { remote: { host: 'me@box', port: 22, base: '/default' } } }
    expect(resolveSSHConnection(cfg, { type: 'ssh', alias: 'remote', port: 2222 })).toEqual({
      location: { type: 'ssh', host: 'me@box', alias: 'remote', port: 2222, base: '/default' },
    })
  })
})

describe('saveHostAliasBinding', () => {
  it('writes the binding to local project config, preserving other content', async () => {
    const dir = join(tmpdir(), `quimby-bind-${crypto.randomUUID()}`)
    await mkdir(join(dir, '.quimby'), { recursive: true })
    await writeYaml(getLocalConfigPath(dir), { roles: { builder: { runtime: 'sbx' } } })
    try {
      const path = await saveHostAliasBinding(dir, 'remote', { host: 'me@box', port: 2222 })
      expect(path).toBe(getLocalConfigPath(dir))
      const written = await loadQuimbyConfig(dir)
      expect(written.hosts?.remote).toEqual({ type: 'ssh', host: 'me@box', port: 2222 })
      expect(written.roles?.builder).toEqual({ runtime: 'sbx' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
