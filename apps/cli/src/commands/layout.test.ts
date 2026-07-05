import { afterEach, describe, expect, it, vi } from 'vitest'

const resolveLayoutPlan = vi.hoisted(() =>
  vi.fn(async () => ({
    version: 1,
    cwd: '/repo',
    source: { default: true, expr: 'builder', name: 'loop' },
    root: { type: 'tabs', terminals: [] },
  })),
)

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({ state: { agents: {} }, repoRoot: '/repo' })),
}))

vi.mock('@quimbyhq/layout', () => ({ resolveLayoutPlan }))

afterEach(() => {
  resolveLayoutPlan.mockClear()
  vi.restoreAllMocks()
})

describe('runLayoutCommand', () => {
  it('prints the default layout plan as JSON and creates missing preset agents first', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { default: command } = await import('./layout')

    await command.run!({ args: { default: true, json: true } } as never)

    expect(resolveLayoutPlan).toHaveBeenCalledWith({
      repoRoot: '/repo',
      name: undefined,
      useDefault: true,
      commandMode: 'cli',
      createMissingPresetAgents: true,
    })
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
