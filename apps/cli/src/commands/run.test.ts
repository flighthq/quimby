import { tmuxSessionName } from '@quimbyhq/paths'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as string[][], sessions: new Set<string>() }))

vi.mock('execa', () => ({
  execa: vi.fn(async (_cmd: string, args: string[] = []) => {
    h.calls.push(args)
    const after = (flag: string) => args[args.indexOf(flag) + 1]
    if (args.includes('has-session')) {
      if (h.sessions.has(after('-t'))) return { stdout: '', stderr: '', exitCode: 0 }
      throw new Error('no session')
    }
    if (args.includes('new-session')) h.sessions.add(after('-s'))
    if (args.includes('kill-session')) h.sessions.delete(after('-t'))
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
  saveState: vi.fn(async () => {}),
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
  h.calls.length = 0
  h.sessions.clear()
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

  it('attaches a single agent to its own session, not a dashboard, despite citty duplicating the positional', async () => {
    const { default: cmd } = await import('./run')
    // citty puts the first positional in both `name` and `_`; `run a` must attach the one
    // agent's own tmux session, not spin up a dashboard.
    await cmd.run!({ args: { name: 'a', _: ['a'] } } as never)
    expect(h.calls.some((c) => c.includes('link-window'))).toBe(false)
    const created = h.calls
      .filter((c) => c.includes('new-session'))
      .map((c) => c[c.indexOf('-s') + 1])
    expect(created).toEqual([tmuxSessionName('id-a')]) // its own session, and only that
  })

  it('links each distinct agent once, not once per positional', async () => {
    const { default: cmd } = await import('./run')
    // Duplicated positional + a real second agent: the dashboard must link "a" a single
    // time (regression: the first agent got its own window twice).
    await cmd.run!({ args: { name: 'a', _: ['a', 'a', 'b'] } } as never)
    const links = h.calls.filter((a) => a.includes('link-window'))
    expect(links).toHaveLength(2)
    expect(links.filter((a) => a.some((x) => x.endsWith(':a')))).toHaveLength(1)
  })

  it('reuses a running per-agent session instead of restarting it', async () => {
    const { default: cmd } = await import('./run')
    h.sessions.add(tmuxSessionName('id-a')) // agent "a" already has a live session
    await cmd.run!({ args: { name: 'a', _: ['a', 'b'] } } as never)
    // so no new-session is created for it — only "b" (and the dashboard) get created.
    const created = h.calls
      .filter((c) => c.includes('new-session'))
      .map((c) => c[c.indexOf('-s') + 1])
    expect(created).not.toContain(tmuxSessionName('id-a'))
    expect(created).toContain(tmuxSessionName('id-b'))
  })
})
