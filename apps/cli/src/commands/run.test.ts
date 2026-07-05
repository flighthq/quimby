import { tmuxSessionName } from '@quimbyhq/paths'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as string[][],
  opts: [] as { env?: Record<string, string | undefined> }[],
  sessions: new Set<string>(),
  dead: false,
  currentSession: 'qb-dash-proj-id',
  paneSize: '120 40',
}))
const state = vi.hoisted(() => ({
  value: {
    id: 'proj-id',
    agents: {
      a: { id: 'id-a', name: 'a', location: { type: 'local' }, defaults: {} },
      b: { id: 'id-b', name: 'b', location: { type: 'local' }, defaults: {} },
    } as Record<
      string,
      {
        id: string
        name: string
        location: { type: 'local' }
        defaults: object
        launchedWith?: string
        role?: string
      }
    >,
  },
}))
const addAgent = vi.hoisted(() =>
  vi.fn(async (_repoRoot: string, name: string, opts: object) => {
    state.value.agents[name] = {
      id: `id-${name}`,
      name,
      location: { type: 'local' },
      defaults: {},
      ...opts,
    }
    return state.value.agents[name]
  }),
)
const config = vi.hoisted(() => ({
  value: {
    default: 'loop',
    roles: {
      builder: { runtime: 'local', entrypoint: 'codex' },
      c: { runtime: 'local', entrypoint: 'codex' },
    },
    layouts: {
      inferred: 'a | c',
      review: 'a | b',
      tabs: 'a b',
      weighted: 'a:80 / b:20',
    },
    presets: {
      inferred: { layout: 'inferred', agents: { a: 'builder' } },
      loop: { layout: 'review', agents: { a: 'builder', b: 'builder' } },
      solo: { layout: { expr: 'a' }, agents: { a: 'builder' } },
      tabbed: { layout: 'tabs', agents: { a: 'builder', b: 'builder' } },
      weighted: { layout: 'weighted', agents: { a: 'builder', b: 'builder' } },
    },
    services: { server: 'quimby serve' },
  },
}))
const saveDefaultPreset = vi.hoisted(() => vi.fn(async () => '/fake/root/.quimby/local.yaml'))
const writeText = vi.hoisted(() => vi.fn(async (_path: string, _text: string) => {}))
const transport = vi.hoisted(() => ({
  exec: vi.fn(async (cmd: string) => {
    if (cmd.includes('has-session')) return new Promise<string>(() => {})
    return ''
  }),
  syncProjectTo: vi.fn(async () => {}),
  fileExists: vi.fn(async () => true),
  checkCapabilities: vi.fn(async () => {}),
  ensureDir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  readFile: vi.fn(async () => ''),
}))

vi.mock('@quimbyhq/agent', () => ({
  addAgent,
  configureRemoteAgentIdentity: vi.fn(async () => {}),
  renderRemoteMailboxMigration: vi.fn(() => ''),
  writeRemoteAgentInstructions: vi.fn(async () => {}),
}))

vi.mock('execa', () => ({
  execa: vi.fn(
    async (
      _cmd: string,
      args: string[] = [],
      opts?: { env?: Record<string, string | undefined> },
    ) => {
      h.calls.push(args)
      h.opts.push(opts ?? {})
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
        if (fmt === '#{pane_width} #{pane_height}')
          return { stdout: h.paneSize, stderr: '', exitCode: 0 }
        return { stdout: h.currentSession, stderr: '', exitCode: 0 }
      }
      if (args.includes('list-panes')) return { stdout: '%0\n', stderr: '', exitCode: 0 }
      if (args.includes('split-window')) return { stdout: '%1\n', stderr: '', exitCode: 0 }
      if (args.includes('list-windows')) return { stdout: '', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  ),
}))

vi.mock('@quimbyhq/runtimes', () => ({
  runtimeTypes: ['local'],
  runtimeCli: () => undefined,
  buildContext: () => ({}),
  getRuntime: () => ({
    setup: async () => {},
    runSpec: () => ({ command: 'claude', args: ['claude'], cwd: '/fake/root', env: {} }),
  }),
  splitCommand: (input: string) => input.trim().split(/\s+/).filter(Boolean),
}))

vi.mock('@quimbyhq/template', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  renderTmuxConfig: () => '',
}))

vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: vi.fn(() => transport),
}))

vi.mock('@quimbyhq/utils', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  writeText,
}))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  saveState: vi.fn(async () => {}),
  saveDefaultPreset,
  loadQuimbyConfig: vi.fn(async () => config.value),
  loadState: vi.fn(async () => state.value),
  resolveWorkspace: vi.fn(async () => ({
    state: state.value,
    repoRoot: '/fake/root',
  })),
}))

// Determinism: the guard keys off $TMUX, and the test runner may itself run inside tmux.
// Clear it per test so the default (non-nested) path is exercised unless a test opts in.
let savedTmux: string | undefined
beforeEach(() => {
  savedTmux = process.env.TMUX
  delete process.env.TMUX
  state.value.agents = {
    a: { id: 'id-a', name: 'a', location: { type: 'local' }, defaults: {} },
    b: { id: 'id-b', name: 'b', location: { type: 'local' }, defaults: {} },
  }
  config.value.default = 'loop'
  addAgent.mockClear()
})

afterEach(() => {
  h.calls.length = 0
  h.opts.length = 0
  h.sessions.clear()
  h.dead = false
  h.currentSession = 'qb-dash-proj-id'
  h.paneSize = '120 40'
  writeText.mockClear()
  transport.exec.mockClear()
  transport.syncProjectTo.mockClear()
  transport.fileExists.mockClear()
  transport.checkCapabilities.mockClear()
  if (savedTmux === undefined) delete process.env.TMUX
  else process.env.TMUX = savedTmux
  delete process.env.QUIMBY_REMOTE_PROBE_TIMEOUT_MS
})

describe('runRunCommand', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./run')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when agent does not exist', async () => {
    const { default: cmd } = await import('./run')
    await expect(cmd.run!({ args: { agent: 'nonexistent' } } as never)).rejects.toThrow('not found')
  })

  it('does not alias --cmd to -c, keeping -c reserved for --clear', async () => {
    const { default: cmd } = await import('./run')
    expect((cmd.args as Record<string, { alias?: string }>).cmd.alias).toBeUndefined()
  })

  it('attaches a single agent to its own session, not a dashboard, despite citty duplicating the positional', async () => {
    const { default: cmd } = await import('./run')
    // citty puts the first positional in both `name` and `_`; `run a` must attach the one
    // agent's own tmux session, not spin up a dashboard.
    await cmd.run!({ args: { agent: 'a', _: ['a'] } } as never)
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
    await cmd.run!({ args: { agent: 'a', _: ['a', 'a', 'b'] } } as never)
    const links = h.calls.filter((a) => a.includes('link-window'))
    expect(links).toHaveLength(2)
    expect(links.filter((a) => a.some((x) => x.endsWith(':a')))).toHaveLength(1)
  })

  it('inside the quimby dashboard, adds the agent as a tab instead of a nested attach', async () => {
    process.env.TMUX = '/tmp/tmux-1000/quimby,42,0' // socket basename "quimby" ⇒ nested
    const { default: cmd } = await import('./run')
    await cmd.run!({ args: { agent: 'a', _: ['a'] } } as never)
    // Never attaches (that would steal the dashboard client and trip its self-destruct hook)
    // and never kills a session (the old bug tore the whole dashboard down).
    expect(h.calls.some((c) => c.includes('attach'))).toBe(false)
    expect(h.calls.some((c) => c.includes('kill-session'))).toBe(false)
    // Instead it links the agent's window into the current session and selects it.
    expect(h.calls.some((c) => c.includes('link-window'))).toBe(true)
    expect(h.calls.some((c) => c.includes('select-window'))).toBe(true)
  })

  it('styles in-dashboard agent tabs with colored state accent bars (no dots or partial circles)', async () => {
    process.env.TMUX = '/tmp/tmux-1000/quimby,42,0'
    const { default: cmd } = await import('./run')
    await cmd.run!({ args: { agent: 'a', _: ['a'] } } as never)
    const flat = h.calls.map((c) => c.join(' ')).join('\n')
    // State is a quarter-width vertical accent bar in different colours plus × for an exited pane.
    expect(flat).toContain('#[fg=colour240]▎#[fg=colour244]') // idle: grey bar + dim title
    expect(flat).toContain('#[fg=colour240]▎#[fg=colour231]#W ') // selected: final space is highlighted
    expect(flat).not.toContain('#[fg=colour240]▎#[fg=colour244]#W ')
    expect(flat).not.toContain('▏')
    expect(flat).toContain('×')
    expect(flat).not.toContain('∙')
    expect(flat).not.toContain('●')
    expect(flat).not.toContain('○')
    expect(flat).not.toContain('◐')
    // The selected format keeps the state accent bar too (grey comes from a session-level base style).
    expect(flat).toContain('window-status-current-format #{?pane_dead')
    expect(flat).not.toContain('bg=colour24')
  })

  it('outside quimby tmux, a foreign $TMUX does not trigger the in-dashboard jump', async () => {
    process.env.TMUX = '/tmp/tmux-1000/default,42,0' // the user's own tmux, not quimby's
    const { default: cmd } = await import('./run')
    await cmd.run!({ args: { agent: 'a', _: ['a'] } } as never)
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
    await cmd.run!({ args: { agent: 'a', _: ['a'] } } as never)
    // respawn-window replays quimby's own launch command in place — no tmux key, no user
    // reconstruction; `quimby run` alone delivers a running agent.
    expect(h.calls.some((c) => c.includes('respawn-window'))).toBe(true)
  })

  it('never respawns a live agent (a running agent is left untouched)', async () => {
    h.sessions.add(tmuxSessionName('id-a'))
    h.dead = false // agent still running
    const { default: cmd } = await import('./run')
    await cmd.run!({ args: { agent: 'a', _: ['a'] } } as never)
    expect(h.calls.some((c) => c.includes('respawn-window'))).toBe(false)
  })

  it('runs a saved layout from config', async () => {
    const { default: cmd } = await import('./run')
    await cmd.run!({ args: { layout: 'review' } } as never)
    expect(h.calls.some((c) => c.includes('split-window'))).toBe(true)
  })

  it('runs a preset layout from config', async () => {
    const { default: cmd } = await import('./run')
    await cmd.run!({ args: { layout: 'loop' } } as never)
    expect(h.calls.some((c) => c.includes('split-window'))).toBe(true)
  })

  it('allows a preset panel layout from inside another project’s quimby tmux', async () => {
    process.env.TMUX = '/tmp/tmux-1000/quimby,42,0'
    h.currentSession = 'qb-dash-other'
    const { default: cmd } = await import('./run')

    await cmd.run!({ args: { layout: 'loop' } } as never)

    const attachIndex = h.calls.findIndex(
      (c) => c.includes('attach') && c.includes('qb-dash-proj-id'),
    )
    expect(attachIndex).toBeGreaterThanOrEqual(0)
    expect(h.opts[attachIndex]?.env?.TMUX).toBe('')
  })

  it('seeds a nested preset panel dashboard with the current pane size before splitting', async () => {
    process.env.TMUX = '/tmp/tmux-1000/quimby,42,0'
    h.currentSession = 'qb-dash-other'
    h.paneSize = '132 50'
    const { default: cmd } = await import('./run')

    await cmd.run!({ args: { layout: 'weighted' } } as never)

    const wrapper = h.calls.find((c) => c.includes('new-session') && c.includes('qb-dash-proj-id'))
    expect(wrapper).toEqual(expect.arrayContaining(['-x', '132', '-y', '50']))

    const split = h.calls.find((c) => c.includes('split-window'))
    expect(split).toEqual(expect.arrayContaining(['-v', '-l', '10']))
    expect(split).not.toContain('20%')

    const rootResizes = h.calls.filter(
      (c) => c.includes('resize-pane') && c.includes('-y') && c.includes('10'),
    )
    expect(rootResizes.length).toBeGreaterThanOrEqual(1)

    expect(
      writeText.mock.calls.some(
        ([path, text]) =>
          String(path).endsWith('panel-resize.sh') && String(text).includes('pane_left'),
      ),
    ).toBe(true)
    expect(h.calls.some((c) => c.includes('set-hook') && c.includes('client-resized'))).toBe(true)
    expect(h.calls.some((c) => c.includes('set-hook') && c.includes('window-resized'))).toBe(true)
  })

  it('still rejects a panel layout from inside this project’s quimby tmux', async () => {
    process.env.TMUX = '/tmp/tmux-1000/quimby,42,0'
    h.currentSession = 'qb-dash-proj-id'
    const { default: cmd } = await import('./run')

    await expect(cmd.run!({ args: { layout: 'loop' } } as never)).rejects.toThrow(
      'outside this project',
    )
  })

  it('allows a preset tab layout from inside another project’s quimby tmux', async () => {
    process.env.TMUX = '/tmp/tmux-1000/quimby,42,0'
    h.currentSession = 'qb-dash-other'
    const { default: cmd } = await import('./run')

    await cmd.run!({ args: { layout: 'tabbed' } } as never)

    const attachIndex = h.calls.findIndex(
      (c) => c.includes('attach') && c.includes('qb-dash-proj-id'),
    )
    expect(attachIndex).toBeGreaterThanOrEqual(0)
    expect(h.opts[attachIndex]?.env?.TMUX).toBe('')
  })

  it('writes panel teardown to succeed when the view group is already gone', async () => {
    const { default: cmd } = await import('./run')

    await cmd.run!({ args: { layout: 'loop' } } as never)

    const teardown = writeText.mock.calls.find(([path]) =>
      String(path).endsWith('panel-teardown.sh'),
    )?.[1]
    expect(teardown).toContain('exit 0')
    expect(teardown).not.toContain('grep "^$prefix"')
  })

  it('opens the configured default preset when run with no target', async () => {
    const { default: cmd } = await import('./run')
    await cmd.run!({ args: {} } as never)
    expect(h.calls.some((c) => c.includes('split-window'))).toBe(true)
  })

  it('creates missing default preset agents before running the default layout', async () => {
    const { default: cmd } = await import('./run')
    state.value.agents = {}

    await cmd.run!({ args: {} } as never)

    expect(addAgent).toHaveBeenCalledWith('/fake/root', 'a', {
      role: 'builder',
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
    expect(addAgent).toHaveBeenCalledWith('/fake/root', 'b', {
      role: 'builder',
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
    expect(h.calls.some((c) => c.includes('split-window'))).toBe(true)
  })

  it('creates missing layout-only preset agents before running the default layout', async () => {
    const { default: cmd } = await import('./run')
    state.value.agents = {}
    config.value.default = 'inferred'
    addAgent.mockClear()

    await cmd.run!({ args: {} } as never)

    expect(addAgent).toHaveBeenCalledWith('/fake/root', 'a', {
      role: 'builder',
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
    expect(addAgent).toHaveBeenCalledWith('/fake/root', 'c', {
      role: 'c',
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
    expect(h.calls.some((c) => c.includes('split-window'))).toBe(true)
  })

  it('creates missing named preset agents before running its layout', async () => {
    const { default: cmd } = await import('./run')
    state.value.agents = {}

    await cmd.run!({ args: { layout: 'solo' } } as never)

    expect(addAgent).toHaveBeenCalledWith('/fake/root', 'a', {
      role: 'builder',
      defaults: { runtime: 'local', entrypoint: 'codex' },
    })
    expect(h.calls.filter((c) => c.includes('new-session')).length).toBeGreaterThan(0)
  })

  it('runs a `$service` layout token as its configured host command', async () => {
    const { default: cmd } = await import('./run')
    await cmd.run!({ args: { agent: 'a / $server' } } as never)
    expect(h.calls.some((c) => c.includes('quimby serve'))).toBe(true)
  })

  it('errors clearly for a layout `$service` not defined under services', async () => {
    const { default: cmd } = await import('./run')
    await expect(cmd.run!({ args: { agent: 'a / $nope' } } as never)).rejects.toThrow(
      /service "nope".*not defined/,
    )
  })

  it('saves the opened layout as the default with --default', async () => {
    const { default: cmd } = await import('./run')
    saveDefaultPreset.mockClear()
    await cmd.run!({ args: { layout: 'loop', default: true } } as never)
    expect(saveDefaultPreset).toHaveBeenCalledWith('/fake/root', 'loop', { global: undefined })
  })

  it('reuses a running per-agent session instead of restarting it', async () => {
    const { default: cmd } = await import('./run')
    h.sessions.add(tmuxSessionName('id-a')) // agent "a" already has a live session
    await cmd.run!({ args: { agent: 'a', _: ['a', 'b'] } } as never)
    // so no new-session is created for it — only "b" (and the dashboard) get created.
    const created = h.calls
      .filter((c) => c.includes('new-session'))
      .map((c) => c[c.indexOf('-s') + 1])
    expect(created).not.toContain(tmuxSessionName('id-a'))
    expect(created).toContain(tmuxSessionName('id-b'))
  })

  it('opens a dashboard prompt for a running agent whose launch config drifted', async () => {
    const { default: cmd } = await import('./run')
    state.value.agents.a.role = 'builder'
    state.value.agents.a.defaults = { runtime: 'local', entrypoint: 'claude' }
    state.value.agents.a.launchedWith = 'local claude'
    h.sessions.add(tmuxSessionName('id-a'))
    await cmd.run!({ args: { agent: 'a', _: ['a', 'b'] } } as never)
    const prompt = h.calls.find((c) => c.includes('new-window') && c[c.indexOf('-n') + 1] === 'a')
    expect(prompt?.join('\n')).toContain('quimby: launch config changed for')
    expect(prompt?.join('\n')).toContain('choice [r/a/q]')
    expect(prompt?.join('\n')).toContain('session:')
    expect(prompt?.join('\n')).toContain('config:')
    expect(prompt?.join('\n')).toContain('#{pane_id}')
    expect(prompt?.join('\n')).toContain('kill-pane')
    expect(prompt?.join('\n')).not.toContain('rename-window')
    expect(prompt?.join('\n')).not.toContain('$agent prompt')
    expect(h.calls.some((c) => c.includes('link-window') && c.includes(`${tmuxSessionName('id-a')}:a`))).toBe(false) // prettier-ignore
  })

  it('does not hang dashboard construction when an SSH stale-launch probe stalls', async () => {
    process.env.QUIMBY_REMOTE_PROBE_TIMEOUT_MS = '1'
    const { default: cmd } = await import('./run')
    state.value.agents.a = {
      id: 'id-a',
      name: 'a',
      location: { type: 'ssh', host: 'me@gpu' },
      defaults: {},
    } as never

    await cmd.run!({ args: { agent: 'a', _: ['a', 'b'] } } as never)

    expect(transport.exec).toHaveBeenCalledWith(expect.stringContaining('has-session'))
    expect(transport.syncProjectTo).toHaveBeenCalled()
    expect(h.calls.some((c) => c.includes('new-window') && c.includes('ssh'))).toBe(true)
  })
})
