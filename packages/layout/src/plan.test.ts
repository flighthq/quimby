import type { QuimbyConfig, QuimbyState } from '@quimbyhq/types'
import { describe, expect, it, vi } from 'vitest'

import { buildResolvedLayoutPlan } from './plan'

vi.mock('@quimbyhq/launch', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  prepareLocalTmuxLaunch: vi.fn(async () => ({
    sessionName: 'qb-agent-builder',
    tmuxConf: '/repo/.quimby/tmux.conf',
    cwd: '/repo/.quimby/agents/agent-builder',
    rootCwd: '/repo',
    envArgs: [],
    shellCmd: 'claude',
    windowName: 'builder',
    runtimeLabel: ' (local)',
  })),
}))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  saveState: vi.fn(async () => {}),
}))

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
  it('resolves a named layout to a renderer-neutral plan', async () => {
    const plan = await buildResolvedLayoutPlan({
      name: 'weighted',
      repoRoot,
      config,
      state: structuredClone(state),
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

  it('resolves the default preset layout', async () => {
    const plan = await buildResolvedLayoutPlan({
      useDefault: true,
      repoRoot,
      config,
      state: structuredClone(state),
    })

    expect(plan.source).toEqual({
      default: true,
      expr: 'builder reviewer | ($ $server):30',
      name: 'loop',
    })
  })

  it('renders host and service tokens as terminal leaves', async () => {
    const plan = await buildResolvedLayoutPlan({
      name: 'cockpit',
      repoRoot,
      config,
      state: structuredClone(state),
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

  it('preserves tab groups inside split structure', async () => {
    const plan = await buildResolvedLayoutPlan({
      name: 'cockpit',
      repoRoot,
      config,
      state: structuredClone(state),
    })

    expect(plan.root.type).toBe('cols')
    if (plan.root.type !== 'cols') throw new Error('expected cols')
    expect(plan.root.children[0]).toMatchObject({
      type: 'tabs',
      terminals: [{ name: 'builder' }, { name: 'reviewer' }],
    })
  })

  it('generates direct retained-session commands for VS Code without a global quimby binary', async () => {
    const plan = await buildResolvedLayoutPlan({
      name: 'review',
      repoRoot,
      config,
      state: structuredClone(state),
      commandMode: 'direct',
    })

    if (plan.root.type !== 'tabs') throw new Error('expected tabs')
    expect(plan.root.terminals[0]).toMatchObject({
      kind: 'agent',
      command: {
        argv: expect.arrayContaining(['tmux', 'new-session', '-A', '-s', 'qb-agent-builder']),
      },
    })
    expect(plan.root.terminals[0].command.argv.slice(0, 3)).not.toEqual([
      'quimby',
      'run',
      'builder',
    ])
  })

  it('expands a @role slot to every instance of that role, in creation order', async () => {
    const roleState: QuimbyState = structuredClone(state)
    roleState.agents.builder.role = 'builder'
    roleState.agents['builder-2'] = {
      id: 'agent-builder-2',
      name: 'builder-2',
      seedCommit: 'seed-builder-2',
      createdAt: '2026-01-02T00:00:00.000Z',
      location: { type: 'local' },
      role: 'builder',
      runtimeProfile: 'codex-sbx',
      defaults: {},
    }

    const plan = await buildResolvedLayoutPlan({
      name: 'fleet',
      repoRoot,
      config: { ...config, layouts: { fleet: '@builder | reviewer' } },
      state: roleState,
    })

    expect(plan.root).toMatchObject({
      type: 'cols',
      children: [
        {
          type: 'tabs',
          terminals: [
            { kind: 'agent', name: 'builder' },
            { kind: 'agent', name: 'builder-2' },
          ],
        },
        { type: 'tabs', terminals: [{ kind: 'agent', name: 'reviewer' }] },
      ],
    })
  })

  it('throws for a @role slot with no matching instances', async () => {
    await expect(
      buildResolvedLayoutPlan({
        name: 'ghost',
        repoRoot,
        config: { ...config, layouts: { ghost: '@ghost' } },
        state: structuredClone(state),
      }),
    ).rejects.toThrow(/no agent has role "ghost"/i)
  })

  it('validates referenced services and agents', async () => {
    await expect(
      buildResolvedLayoutPlan({
        name: 'missing-service',
        repoRoot,
        config: { ...config, layouts: { 'missing-service': '$unknown' } },
        state: structuredClone(state),
      }),
    ).rejects.toThrow(/service "unknown"/i)

    await expect(
      buildResolvedLayoutPlan({
        name: 'missing-agent',
        repoRoot,
        config: { ...config, layouts: { 'missing-agent': 'absent' } },
        state: structuredClone(state),
      }),
    ).rejects.toThrow(/agent "absent" not found/i)
  })
})
