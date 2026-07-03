import { tmuxSessionName } from '@quimbyhq/paths'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as string[][],
  sessions: new Set<string>(),
  dead: false,
}))

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
    if (args.includes('display-message')) {
      // reviveIfDead asks for #{pane_dead}; the within-dashboard jump asks for the session name.
      const fmt = args[args.length - 1]
      if (fmt === '#{pane_dead}') return { stdout: h.dead ? '1' : '', stderr: '', exitCode: 0 }
      return { stdout: 'qb-dash-proj-id', stderr: '', exitCode: 0 }
    }
    if (args.includes('list-windows')) return { stdout: '', stderr: '', exitCode: 0 }
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

// Determinism: the guard keys off $TMUX, and the test runner may itself run inside tmux.
// Clear it per test so the default (non-nested) path is exercised unless a test opts in.
let savedTmux: string | undefined
beforeEach(() => {
  savedTmux = process.env.TMUX
  delete process.env.TMUX
})

afterEach(() => {
  h.calls.length = 0
  h.sessions.clear()
  h.dead = false
  if (savedTmux === undefined) delete process.env.TMUX
  else process.env.TMUX = savedTmux
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

  it('does not alias --cmd to -c, keeping -c reserved for --clear', async () => {
    const { default: cmd } = await import('./run')
    expect((cmd.args as Record<string, { alias?: string }>).cmd.alias).toBeUndefined()
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

  it('inside the quimby dashboard, adds the agent as a tab instead of a nested attach', async () => {
    process.env.TMUX = '/tmp/tmux-1000/quimby,42,0' // socket basename "quimby" ⇒ nested
    const { default: cmd } = await import('./run')
    await cmd.run!({ args: { name: 'a', _: ['a'] } } as never)
    // Never attaches (that would steal the dashboard client and trip its self-destruct hook)
    // and never kills a session (the old bug tore the whole dashboard down).
    expect(h.calls.some((c) => c.includes('attach'))).toBe(false)
    expect(h.calls.some((c) => c.includes('kill-session'))).toBe(false)
    // Instead it links the agent's window into the current session and selects it.
    expect(h.calls.some((c) => c.includes('link-window'))).toBe(true)
    expect(h.calls.some((c) => c.includes('select-window'))).toBe(true)
  })

  it('outside quimby tmux, a foreign $TMUX does not trigger the in-dashboard jump', async () => {
    process.env.TMUX = '/tmp/tmux-1000/default,42,0' // the user's own tmux, not quimby's
    const { default: cmd } = await import('./run')
    await cmd.run!({ args: { name: 'a', _: ['a'] } } as never)
    // Normal single-agent path: attaches its own session, no link-window jump.
    expect(h.calls.some((c) => c.includes('link-window'))).toBe(false)
    const created = h.calls
      .filter((c) => c.includes('new-session'))
      .map((c) => c[c.indexOf('-s') + 1])
    expect(created).toEqual([tmuxSessionName('id-a')])
  })

  it('revives a dead-held agent before attaching, so recovery stays inside `quimby run`', async () => {
    h.sessions.add(tmuxSessionName('id-a')) // session held alive...
    h.dead = true // ...but its agent process has exited (a dead pane)
    const { default: cmd } = await import('./run')
    await cmd.run!({ args: { name: 'a', _: ['a'] } } as never)
    // respawn-window replays quimby's own launch command in place — no tmux key, no user
    // reconstruction; `quimby run` alone delivers a running agent.
    expect(h.calls.some((c) => c.includes('respawn-window'))).toBe(true)
  })

  it('never respawns a live agent (a running agent is left untouched)', async () => {
    h.sessions.add(tmuxSessionName('id-a'))
    h.dead = false // agent still running
    const { default: cmd } = await import('./run')
    await cmd.run!({ args: { name: 'a', _: ['a'] } } as never)
    expect(h.calls.some((c) => c.includes('respawn-window'))).toBe(false)
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
