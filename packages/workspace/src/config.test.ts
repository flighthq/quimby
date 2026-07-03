import { describe, expect, it } from 'vitest'

import {
  normalizeCheck,
  resolveAgentRoleConfig,
  resolveConfiguredAgent,
  resolveHostAlias,
  resolveLayoutExpr,
  resolveRecipe,
  resolveRecipeLayout,
  resolveRole,
} from './config'

const config = {
  defaults: {
    runtime: 'local',
    entrypoint: 'claude',
    check: { command: 'npm test', verifyByDefault: false },
  },
  roles: {
    builder: {
      runtime: 'sbx',
      check: { command: 'npm run ci' },
      tmux: true,
    },
    reviewer: {
      entrypoint: 'codex --model "gpt 5"',
      check: 'npm run lint',
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

describe('quimby config helpers', () => {
  it('merges defaults into a role and lets the role override fields', () => {
    expect(resolveRole(config, 'builder')).toMatchObject({
      runtime: 'sbx',
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
