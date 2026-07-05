import type { QuimbyConfig, QuimbyState } from '@quimbyhq/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  value: {
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
    },
  } satisfies QuimbyState,
}))

const config = vi.hoisted(() => ({
  value: {
    default: 'loop',
    layouts: {
      review: 'builder',
    },
    presets: {
      loop: {
        layout: 'review',
        agents: { builder: 'builder' },
      },
    },
  } satisfies QuimbyConfig,
}))

const createMissingPresetAgents = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  loadQuimbyConfig: vi.fn(async () => config.value),
  resolveWorkspace: vi.fn(async () => ({ state: state.value, repoRoot: '/repo' })),
}))

vi.mock('../presetAgents', () => ({
  createMissingPresetAgents,
}))

afterEach(() => {
  createMissingPresetAgents.mockClear()
  vi.restoreAllMocks()
})

describe('runLayoutCommand', () => {
  it('prints the default layout plan as JSON and creates missing preset agents first', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { default: command } = await import('./layout')

    await command.run!({ args: { default: true, json: true } } as never)

    expect(createMissingPresetAgents).toHaveBeenCalledWith('/repo', config.value, 'loop')
    const plan = JSON.parse(log.mock.calls[0][0] as string) as {
      source: { name: string }
      root: { type: string }
    }
    expect(plan.source.name).toBe('loop')
    expect(plan.root.type).toBe('tabs')
  })

  it('requires --json for the first slice', async () => {
    const { default: command } = await import('./layout')

    await expect(command.run!({ args: { default: true } } as never)).rejects.toThrow(
      /only json output/i,
    )
  })
})
