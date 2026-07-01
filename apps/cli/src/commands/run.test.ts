import { afterEach, describe, expect, it, vi } from 'vitest'

const execaCalls: string[][] = []

vi.mock('execa', () => ({
  execa: vi.fn(async (_cmd: string, args: string[]) => {
    execaCalls.push(args)
    return { stdout: '', stderr: '', exitCode: 0 }
  }),
}))

vi.mock('@quimbyhq/runtimes', () => ({
  runtimeTypes: ['local'],
  buildContext: () => ({}),
  getRuntime: () => ({
    runSpec: () => ({ command: 'claude', args: ['claude'], cwd: '/fake/root', env: {} }),
  }),
}))

vi.mock('@quimbyhq/template', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  renderTmuxConfig: () => '',
}))

vi.mock('@quimbyhq/utils', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  writeText: vi.fn(async () => {}),
}))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: {
      id: 'proj-id',
      subscriptions: {},
      agents: {
        a: { id: 'id-a', name: 'a', location: { type: 'local' }, defaults: {} },
        b: { id: 'id-b', name: 'b', location: { type: 'local' }, defaults: {} },
      },
    },
    repoRoot: '/fake/root',
  })),
}))

afterEach(() => {
  execaCalls.length = 0
})

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./run')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when agent does not exist', async () => {
    const { default: cmd } = await import('./run')
    await expect(cmd.run!({ args: { name: 'nonexistent' } } as never)).rejects.toThrow('not found')
  })

  it('opens one window per distinct agent, not one per positional', async () => {
    const { default: cmd } = await import('./run')
    // citty duplicates the first positional into both `name` and `_`; the dashboard
    // must dedupe so agent "a" gets a single window (regression: it ran twice).
    await cmd.run!({ args: { name: 'a', _: ['a', 'b'] } } as never)
    const newSession = execaCalls.filter((a) => a.includes('new-session'))
    const newWindow = execaCalls.filter((a) => a.includes('new-window'))
    expect(newSession).toHaveLength(1)
    expect(newWindow).toHaveLength(1)
  })
})
