import { collectingReporter } from '@quimbyhq/reporter'
import { sq } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildRemoteNudgeCommand,
  hasAgentSession,
  nudgeAgentSession,
  shouldHoldNudge,
} from './nudge'

const execa = vi.hoisted(() => vi.fn())
const getSessionState = vi.hoisted(() => vi.fn(async () => 'running' as string))
const getFocused = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      ids: Set<string>
      windows: { windowId: string; windowName: string; session: string }[]
    }> => ({ ids: new Set<string>(), windows: [] }),
  ),
)
const hasLocalWindow = vi.hoisted(() => vi.fn(async () => true))

vi.mock('execa', () => ({ execa }))
// The `/clear` settle delay is real time — collapse it so the clear-path test is fast.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }))
// The §7 attached-skip probes getAgentSessionState; default it to `running` (skip bypassed) so the
// existing send/warn tests are unaffected — the attached-skip tests override it to `attached`.
vi.mock('./sessionState', () => ({ getAgentSessionState: getSessionState }))
// §7 is focus-aware: an attached session only holds when its window is the one being typed in.
// Default to "focused on nothing" so the existing send/warn tests are unaffected.
vi.mock('./focus', () => ({
  getFocusedTmuxWindows: getFocused,
  hasLocalWindowNamed: hasLocalWindow,
}))

let prevTmux: string | undefined

beforeEach(() => {
  execa.mockReset()
  getSessionState.mockReset()
  getSessionState.mockResolvedValue('running')
  getFocused.mockReset()
  getFocused.mockResolvedValue({ ids: new Set<string>(), windows: [] })
  hasLocalWindow.mockReset()
  hasLocalWindow.mockResolvedValue(true)
  // No quimby tmux server in test: `has-session` (and every tmux call) fails by
  // default, so a nudge warns rather than pretending a live session exists.
  execa.mockRejectedValue(new Error('no tmux server'))
  // Neutralize the dashboard self-pane guard by default (it only probes when running inside
  // the quimby tmux server); the dedicated guard test opts back in.
  prevTmux = process.env.TMUX
  delete process.env.TMUX
})

afterEach(() => {
  if (prevTmux === undefined) delete process.env.TMUX
  else process.env.TMUX = prevTmux
})

const localNoTmux: AgentState = {
  id: 'a1',
  name: 'builder',
  location: { type: 'local' },
} as AgentState

const localWithTmux: AgentState = {
  id: 'a2',
  name: 'reviewer',
  location: { type: 'local' },
  tmux: true,
} as AgentState

describe('buildRemoteNudgeCommand', () => {
  it('guards on has-session and types + submits the literal text', () => {
    const cmd = buildRemoteNudgeCommand('qb-sess', 'continue', false)
    expect(cmd).toContain(`has-session -t ${sq('qb-sess')}`)
    expect(cmd).toContain(`send-keys -t ${sq('qb-sess')} -l ${sq('continue')}`)
    expect(cmd).toContain('sleep 0.15')
    expect(cmd).toContain('Enter')
  })

  it('omits the clear step when clear is false', () => {
    const cmd = buildRemoteNudgeCommand('s', 'go', false)
    expect(cmd).not.toContain('/clear')
    expect(cmd).not.toContain('sleep 0.6')
    expect(cmd).toContain('sleep 0.15')
  })

  it('types /clear with a settle beat before the nudge when clear is true', () => {
    const cmd = buildRemoteNudgeCommand('s', 'go', true)
    const clearAt = cmd.indexOf(sq('/clear'))
    const sleepAt = cmd.indexOf('sleep 0.6')
    const goAt = cmd.lastIndexOf(sq('go'))
    const submitSleepAt = cmd.lastIndexOf('sleep 0.15')
    expect(clearAt).toBeGreaterThanOrEqual(0)
    // /clear is sent, then a sleep, then the nudge text — in that order
    expect(clearAt).toBeLessThan(sleepAt)
    expect(sleepAt).toBeLessThan(goAt)
    expect(goAt).toBeLessThan(submitSleepAt)
  })

  it('single-quotes text with spaces and quotes so the remote shell keeps it literal', () => {
    const cmd = buildRemoteNudgeCommand('s', "it's a test", false)
    expect(cmd).toContain(`-l ${sq("it's a test")}`)
  })
})

describe('hasAgentSession', () => {
  it('is false for a local agent without tmux', async () => {
    expect(await hasAgentSession(localNoTmux)).toBe(false)
  })

  it('attempts tmux has-session for a tmux-enabled local agent', async () => {
    // No quimby tmux server is running in test, so has-session returns false
    expect(await hasAgentSession(localWithTmux)).toBe(false)
  })
})

describe('nudgeAgentSession', () => {
  it('no-ops for a local agent without tmux', async () => {
    await expect(
      nudgeAgentSession({ agent: localNoTmux, displayName: 'builder', text: 'continue' }),
    ).resolves.toBeUndefined()
  })

  it('no-ops with clear set for a local agent without tmux', async () => {
    await expect(
      nudgeAgentSession({
        agent: localNoTmux,
        clear: true,
        displayName: 'builder',
        text: 'continue',
      }),
    ).resolves.toBeUndefined()
  })

  it('warns gracefully when the tmux session is not running', async () => {
    // No quimby tmux server in test — the nudge should warn but not throw
    await expect(
      nudgeAgentSession({ agent: localWithTmux, displayName: 'reviewer', text: 'continue' }),
    ).resolves.toBeUndefined()
  })

  it('warns gracefully with clear set when the tmux session is not running', async () => {
    await expect(
      nudgeAgentSession({
        agent: localWithTmux,
        clear: true,
        displayName: 'reviewer',
        text: 'continue',
      }),
    ).resolves.toBeUndefined()
  })

  it('types the literal text then Enter and reports success for a running local tmux agent', async () => {
    // Every tmux call succeeds — has-session finds the session, send-keys go through.
    execa.mockResolvedValue({})
    const { reporter, events } = collectingReporter()

    await nudgeAgentSession({
      agent: localWithTmux,
      displayName: 'reviewer',
      text: 'go now',
      reporter,
    })

    const argvs = execa.mock.calls.map((c) => c[1] as string[])
    // guarded on has-session first
    expect(argvs[0]).toContain('has-session')
    // a send-keys types the literal text (`-l`) …
    const literal = argvs.find(
      (a) => a.includes('send-keys') && a.includes('-l') && a.includes('go now'),
    )
    expect(literal).toBeDefined()
    // … then a separate send-keys submits with Enter
    const enter = argvs.find((a) => a.includes('send-keys') && a.includes('Enter'))
    expect(enter).toBeDefined()
    expect(argvs.findIndex((a) => a.includes('-l') && a.includes('go now'))).toBeLessThan(
      argvs.findIndex((a) => a.includes('Enter')),
    )
    expect(events.some((e) => e.level === 'success')).toBe(true)
  })

  it('renders a courier label with the `quimby ·` lead so the agent can tell it from live user input', async () => {
    execa.mockResolvedValue({})
    const { reporter } = collectingReporter()

    await nudgeAgentSession({
      agent: localWithTmux,
      displayName: 'builder',
      courier: 'parcel review-abc123 from review',
      reporter,
    })

    const argvs = execa.mock.calls.map((c) => c[1] as string[])
    // The literal typed is `quimby · <label>`, never the bare label.
    const literal = argvs.find(
      (a) =>
        a.includes('send-keys') &&
        a.includes('-l') &&
        a.includes('quimby · parcel review-abc123 from review'),
    )
    expect(literal).toBeDefined()
    // `courier` supersedes any `text`; no bare label is typed.
    expect(
      argvs.some((a) => a.includes('-l') && a.at(-1) === 'parcel review-abc123 from review'),
    ).toBe(false)
  })

  it('types /clear before the nudge text when clear is set', async () => {
    execa.mockResolvedValue({})
    const { reporter, events } = collectingReporter()

    await nudgeAgentSession({
      agent: localWithTmux,
      clear: true,
      displayName: 'reviewer',
      text: 'go now',
      reporter,
    })

    const argvs = execa.mock.calls.map((c) => c[1] as string[])
    const clearAt = argvs.findIndex(
      (a) => a.includes('send-keys') && a.includes('-l') && a.includes('/clear'),
    )
    const textAt = argvs.findIndex(
      (a) => a.includes('send-keys') && a.includes('-l') && a.includes('go now'),
    )
    expect(clearAt).toBeGreaterThanOrEqual(0)
    // /clear is typed before the nudge text
    expect(textAt).toBeGreaterThan(clearAt)
    expect(events.some((e) => e.level === 'success' && e.message.includes('cleared context'))).toBe(
      true,
    )
  })

  it('skips the send (dashboard guard) when the target session is the pane we are in', async () => {
    // We are inside the quimby tmux server, and both "current pane" and the target session's
    // active pane resolve to the same id — sending would type into the user's own shell.
    process.env.TMUX = '/tmp/tmux-1000/quimby,4242,0'
    execa.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('display-message')) return { stdout: '%7\n' }
      return {}
    })
    const { reporter, events } = collectingReporter()

    await expect(
      nudgeAgentSession({ agent: localWithTmux, displayName: 'reviewer', text: 'go', reporter }),
    ).resolves.toBeUndefined()

    // The guard fires before any send-keys, so nothing is typed.
    const sentKeys = execa.mock.calls.some((c) => (c[1] as string[]).includes('send-keys'))
    expect(sentKeys).toBe(false)
    expect(events.some((e) => e.level === 'warn' && e.message.includes('dashboard'))).toBe(true)
  })

  it('sends normally when inside tmux but the target pane differs from ours', async () => {
    process.env.TMUX = '/tmp/tmux-1000/quimby,4242,0'
    execa.mockImplementation(async (_cmd: string, args: string[]) => {
      // Our pane is %1; the target session's active pane is %7 — distinct, so no self-nudge.
      if (args.includes('display-message')) return { stdout: args.includes('-t') ? '%7\n' : '%1\n' }
      return {}
    })
    const { reporter, events } = collectingReporter()

    await nudgeAgentSession({ agent: localWithTmux, displayName: 'reviewer', text: 'go', reporter })

    const sentKeys = execa.mock.calls.some((c) => (c[1] as string[]).includes('send-keys'))
    expect(sentKeys).toBe(true)
    expect(events.some((e) => e.level === 'success')).toBe(true)
  })

  it('does not throw and warns when has-session fails (agent not running)', async () => {
    execa.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('has-session')) throw new Error('no session')
      return {}
    })
    const { reporter, events } = collectingReporter()

    await expect(
      nudgeAgentSession({ agent: localWithTmux, displayName: 'reviewer', text: 'go', reporter }),
    ).resolves.toBeUndefined()

    // never got as far as typing keys
    const sentKeys = execa.mock.calls.some((c) => (c[1] as string[]).includes('send-keys'))
    expect(sentKeys).toBe(false)
    expect(events.some((e) => e.level === 'warn' && e.message.includes("isn't running"))).toBe(true)
  })

  it('points a stopped agent at `quimby start` (headless), not `quimby run`', async () => {
    execa.mockImplementation(async (_cmd: string, args: string[] = []) => {
      if (args.includes('has-session')) throw new Error('no session')
      return {}
    })
    const { reporter, events } = collectingReporter()
    await nudgeAgentSession({ agent: localWithTmux, displayName: 'reviewer', text: 'go', reporter })
    const warn = events.find((e) => e.level === 'warn')?.message ?? ''
    expect(warn).toContain('quimby start reviewer')
    expect(warn).not.toContain('quimby run')
  })

  it('falls back to a flash without -N when tmux is too old to know the flag', async () => {
    getSessionState.mockResolvedValueOnce('attached')
    getFocused.mockResolvedValueOnce({
      ids: new Set(['@7']),
      windows: [{ windowId: '@7', windowName: 'reviewer', session: 'qbv-proj-0' }],
    })
    execa.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('display-message') && args.includes('-N'))
        throw new Error('unknown flag -N')
      // The window-id probe the local focus match reads before deciding to hold.
      if (args.includes('display-message') && args.includes('-p')) return { stdout: '@7' }
      return {}
    })
    const { reporter } = collectingReporter()
    await nudgeAgentSession({ agent: localWithTmux, displayName: 'reviewer', text: 'go', reporter })

    const flashes = execa.mock.calls.filter(
      (c) => (c[1] as string[]).includes('display-message') && !(c[1] as string[]).includes('-p'),
    )
    expect(flashes).toHaveLength(2)
    expect(flashes[1][1] as string[]).not.toContain('-N')
    expect((flashes[1][1] as string[]).at(-1)).toContain('held while you type')
  })

  it('holds the nudge (no send-keys) when the recipient is the window you are in — §7', async () => {
    getSessionState.mockResolvedValueOnce('attached')
    getFocused.mockResolvedValueOnce({
      ids: new Set(['@7']),
      windows: [{ windowId: '@7', windowName: 'reviewer', session: 'qbv-proj-0' }],
    })
    execa.mockResolvedValue({ stdout: '@7' })
    const { reporter, events } = collectingReporter()
    await nudgeAgentSession({ agent: localWithTmux, displayName: 'reviewer', text: 'go', reporter })
    const sentKeys = execa.mock.calls.some((c) => (c[1] as string[]).includes('send-keys'))
    expect(sentKeys).toBe(false)
    expect(events.some((e) => e.message.includes('Held nudge'))).toBe(true)

    // …but it flashes the status line of the very session it held, so the person typing in that
    // pane learns work arrived. Never via send-keys: that would land in their half-typed prompt.
    const flash = execa.mock.calls.find(
      (c) => (c[1] as string[]).includes('display-message') && !(c[1] as string[]).includes('-p'),
    )
    expect(flash).toBeDefined()
    expect((flash![1] as string[]).at(-1)).toContain('held while you type')
    // -N or the flash is wiped by the very keystroke that caused it to be held.
    expect(flash![1] as string[]).toContain('-N')
  })

  it('sends to an attached agent you are NOT focused on (the dashboard sibling case)', async () => {
    getSessionState.mockResolvedValueOnce('attached')
    getFocused.mockResolvedValueOnce({
      ids: new Set<string>(),
      windows: [{ windowId: '@x', windowName: 'builder', session: 'qbv-proj-0' }],
    })
    execa.mockResolvedValue({ stdout: '@99' })
    const { reporter } = collectingReporter()
    await nudgeAgentSession({ agent: localWithTmux, displayName: 'reviewer', text: 'go', reporter })
    const sentKeys = execa.mock.calls.some((c) => (c[1] as string[]).includes('send-keys'))
    expect(sentKeys).toBe(true)
  })

  it('types into the focused window under `whenFocused: nudge` — the fleet you watch, not talk to', async () => {
    getSessionState.mockResolvedValueOnce('attached')
    getFocused.mockResolvedValueOnce({
      ids: new Set<string>(),
      windows: [{ windowId: '@x', windowName: 'reviewer', session: 'qbv-proj-0' }],
    })
    execa.mockResolvedValue({})
    const { reporter, events } = collectingReporter()
    await nudgeAgentSession({
      agent: localWithTmux,
      displayName: 'reviewer',
      text: 'go',
      whenFocused: 'nudge',
      reporter,
    })
    const sentKeys = execa.mock.calls.some((c) => (c[1] as string[]).includes('send-keys'))
    expect(sentKeys).toBe(true)
    expect(events.some((e) => e.message.includes('Held nudge'))).toBe(false)
  })

  it('names `whenFocused` in the held message, so the hold is not a dead end', async () => {
    getSessionState.mockResolvedValueOnce('attached')
    getFocused.mockResolvedValueOnce({
      ids: new Set(['@7']),
      windows: [{ windowId: '@7', windowName: 'reviewer', session: 'qbv-proj-0' }],
    })
    execa.mockResolvedValue({ stdout: '@7' })
    const { reporter, events } = collectingReporter()
    await nudgeAgentSession({ agent: localWithTmux, displayName: 'reviewer', text: 'go', reporter })
    const held = events.find((e) => e.message.includes('Held nudge'))
    expect(held?.message).toContain('whenFocused: nudge')
  })

  it('forces the nudge into an attached session when force is set', async () => {
    getSessionState.mockResolvedValueOnce('attached')
    execa.mockResolvedValue({})
    const { reporter } = collectingReporter()
    await nudgeAgentSession({
      agent: localWithTmux,
      displayName: 'reviewer',
      text: 'go',
      force: true,
      reporter,
    })
    const sentKeys = execa.mock.calls.some((c) => (c[1] as string[]).includes('send-keys'))
    expect(sentKeys).toBe(true)
  })
})

describe('shouldHoldNudge', () => {
  const sshAgent = {
    id: 'a3',
    name: 'researcher',
    location: { type: 'ssh', host: 'user@box', base: '~' },
  } as AgentState

  it('never holds when the session is not attached', async () => {
    getSessionState.mockResolvedValue('running')
    getFocused.mockResolvedValue({
      ids: new Set<string>(),
      windows: [{ windowId: '@x', windowName: 'reviewer', session: 'qbv-proj-0' }],
    })
    expect(await shouldHoldNudge(localWithTmux, 'reviewer')).toBe(false)
  })

  it('holds a local agent whose window id is the focused one — the id, not the name', async () => {
    getSessionState.mockResolvedValue('attached')
    getFocused.mockResolvedValue({ ids: new Set(['@7']), windows: [] })
    execa.mockResolvedValue({ stdout: '@7' })
    expect(await shouldHoldNudge(localWithTmux, 'reviewer')).toBe(true)
  })

  it('does not hold an attached agent you are not focused on — the dashboard fix', async () => {
    getSessionState.mockResolvedValue('attached')
    getFocused.mockResolvedValue({
      ids: new Set(['@7']),
      windows: [{ windowId: '@x', windowName: 'builder', session: 'qbv-proj-0' }],
    })
    execa.mockResolvedValue({ stdout: '@99' })
    expect(await shouldHoldNudge(localWithTmux, 'reviewer')).toBe(false)
  })

  it('holds an attached SSH agent with no local window — a bare `quimby run` in a terminal', async () => {
    getSessionState.mockResolvedValue('attached')
    getFocused.mockResolvedValue({ ids: new Set<string>(), windows: [] })
    hasLocalWindow.mockResolvedValue(false)
    expect(await shouldHoldNudge(sshAgent, 'researcher')).toBe(true)

    // …but an SSH agent shown as an unfocused dashboard tab does have one, so it sends.
    hasLocalWindow.mockResolvedValue(true)
    expect(await shouldHoldNudge(sshAgent, 'researcher')).toBe(false)
  })

  it('is about live keystrokes only — the `nudge` policy is settled before this runs', async () => {
    // A detached session is never held, however interrupt-hungry the fleet's policy is: the guard
    // exists to avoid typing over a human, and there is no human here.
    getSessionState.mockResolvedValue('running')
    getFocused.mockResolvedValue({
      ids: new Set<string>(),
      windows: [{ windowId: '@x', windowName: 'reviewer', session: 'qbv-proj-0' }],
    })
    expect(await shouldHoldNudge(localWithTmux, 'reviewer')).toBe(false)
  })

  it('does not hold on a same-named window in ANOTHER workspace (the shared socket is machine-wide)', async () => {
    // `list-clients`/`list-panes -a` read the whole `-L quimby` socket, so `focused.names` mixes
    // every project on the machine. Agent names repeat across projects (`review`, `builder`), and
    // a window NAME carries no project id — only the session does. Typing in project A's `builder`
    // must not hold project B's.
    getSessionState.mockResolvedValue('attached')
    getFocused.mockResolvedValue({
      ids: new Set(['@7']), // project A's builder window
      windows: [{ windowId: '@7', windowName: 'builder', session: 'qbv-projectA-0' }],
    })
    execa.mockResolvedValue({ stdout: '@99' }) // THIS builder's window — a different one
    expect(await shouldHoldNudge(localWithTmux, 'builder', { projectId: 'projectB' })).toBe(false)
  })

  it('holds an SSH agent named in THIS project’s dashboard, but not another workspace’s', async () => {
    getSessionState.mockResolvedValue('attached')
    hasLocalWindow.mockResolvedValue(true)
    const focusedIn = (session: string) => ({
      ids: new Set(['@7']),
      windows: [{ windowId: '@7', windowName: 'researcher', session }],
    })

    getFocused.mockResolvedValue(focusedIn('qbv-projectB-0'))
    expect(await shouldHoldNudge(sshAgent, 'researcher', { projectId: 'projectB' })).toBe(true)

    // Same agent name, someone else's workspace — must not hold ours.
    getFocused.mockResolvedValue(focusedIn('qbv-projectA-0'))
    expect(await shouldHoldNudge(sshAgent, 'researcher', { projectId: 'projectB' })).toBe(false)
  })

  it('releases the hold under `whenFocused: nudge`, without probing tmux at all', async () => {
    getSessionState.mockClear()
    getFocused.mockClear()
    getSessionState.mockResolvedValue('attached')
    getFocused.mockResolvedValue({
      ids: new Set<string>(),
      windows: [{ windowId: '@x', windowName: 'reviewer', session: 'qbv-proj-0' }],
    })
    expect(await shouldHoldNudge(localWithTmux, 'reviewer', { whenFocused: 'nudge' })).toBe(false)
    // Short-circuits before the session/focus probes — the policy is the whole answer.
    expect(getSessionState).not.toHaveBeenCalled()
    expect(getFocused).not.toHaveBeenCalled()
  })

  it('still holds under an explicit `hold`, the default', async () => {
    getSessionState.mockResolvedValue('attached')
    getFocused.mockResolvedValue({
      ids: new Set(['@7']),
      windows: [{ windowId: '@7', windowName: 'reviewer', session: 'qbv-proj-0' }],
    })
    execa.mockResolvedValue({ stdout: '@7' })
    expect(await shouldHoldNudge(localWithTmux, 'reviewer', { whenFocused: 'hold' })).toBe(true)
  })
})
