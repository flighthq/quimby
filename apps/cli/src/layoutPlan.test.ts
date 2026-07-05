import type { QuimbyConfig, QuimbyState } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import { buildResolvedLayoutPlan } from './layoutPlan'

const repoRoot = '/repo'

const state: QuimbyState = {
  id: 'project-id',
  sourceRepo: '/repo',
  sourceRef: 'main',
  snapshot: 'abc123',
  createdAt: '2026-01-01T00:00:00.000Z',
  agents: {
    builder: {
      id: 'agent-builder',
      name: 'builder',
      seedCommit: 'seed-builder',
      createdAt: '2026-01-01T00:00:00.000Z',
      location: { type: 'local' },
      defaults: {},
    },
    reviewer: {
      id: 'agent-reviewer',
      name: 'reviewer',
      seedCommit: 'seed-reviewer',
      createdAt: '2026-01-01T00:00:00.000Z',
      location: { type: 'local' },
      defaults: {},
    },
    test: {
      id: 'agent-test',
      name: 'test',
      seedCommit: 'seed-test',
      createdAt: '2026-01-01T00:00:00.000Z',
      location: { type: 'local' },
      defaults: {},
    },
  },
}

const config: QuimbyConfig = {
  default: 'loop',
  layouts: {
    cockpit: 'builder reviewer | ($ $server):30',
    review: 'builder reviewer',
    weighted: 'builder:70 / test:30',
  },
  presets: {
    loop: {
      layout: 'cockpit',
      agents: { builder: 'builder', reviewer: 'builder' },
    },
  },
  services: {
    server: 'quimby serve',
  },
}

describe('buildResolvedLayoutPlan', () => {
  it('resolves a named layout to a renderer-neutral plan', () => {
    const plan = buildResolvedLayoutPlan({
      name: 'weighted',
      repoRoot,
      config,
      state,
    })

    expect(plan.source).toEqual({ default: false, expr: 'builder:70 / test:30', name: 'weighted' })
    expect(plan.root).toMatchObject({
      type: 'rows',
      children: [
        {
          type: 'tabs',
          weight: 70,
          terminals: [
            {
              kind: 'agent',
              name: 'builder',
              displayName: 'builder',
              cwd: repoRoot,
              command: { argv: ['quimby', 'run', 'builder'], string: 'quimby run builder' },
            },
          ],
        },
        { type: 'tabs', weight: 30 },
      ],
    })
  })

  it('resolves the default preset layout', () => {
    const plan = buildResolvedLayoutPlan({
      useDefault: true,
      repoRoot,
      config,
      state,
    })

    expect(plan.source).toEqual({
      default: true,
      expr: 'builder reviewer | ($ $server):30',
      name: 'loop',
    })
  })

  it('renders host and service tokens as terminal leaves', () => {
    const plan = buildResolvedLayoutPlan({
      name: 'cockpit',
      repoRoot,
      config,
      state,
    })

    expect(plan.root).toMatchObject({
      type: 'cols',
      children: [
        {
          type: 'tabs',
          terminals: [
            { kind: 'agent', name: 'builder', displayName: 'builder' },
            { kind: 'agent', name: 'reviewer', displayName: 'reviewer' },
          ],
        },
        {
          type: 'tabs',
          weight: 30,
          terminals: [
            {
              kind: 'host',
              name: '$',
              displayName: '$',
              command: { argv: ['bash', '-l'], string: 'bash -l' },
            },
            {
              kind: 'service',
              name: '$server',
              displayName: 'server',
              command: { argv: ['bash', '-l', '-c', 'quimby serve'], string: 'quimby serve' },
            },
          ],
        },
      ],
    })
  })

  it('preserves tab groups inside split structure', () => {
    const plan = buildResolvedLayoutPlan({
      name: 'cockpit',
      repoRoot,
      config,
      state,
    })

    expect(plan.root.type).toBe('cols')
    if (plan.root.type !== 'cols') throw new Error('expected cols')
    expect(plan.root.children[0]).toMatchObject({
      type: 'tabs',
      terminals: [{ name: 'builder' }, { name: 'reviewer' }],
    })
  })

  it('validates referenced services and agents', () => {
    expect(() =>
      buildResolvedLayoutPlan({
        name: 'missing-service',
        repoRoot,
        config: { ...config, layouts: { 'missing-service': '$unknown' } },
        state,
      }),
    ).toThrow(/service "unknown"/i)

    expect(() =>
      buildResolvedLayoutPlan({
        name: 'missing-agent',
        repoRoot,
        config: { ...config, layouts: { 'missing-agent': 'absent' } },
        state,
      }),
    ).toThrow(/agent "absent" not found/i)
  })
})
