import { collectingReporter } from '@quimbyhq/reporter'
import { sq } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildRemoteNudgeCommand, hasAgentSession, nudgeAgentSession } from './nudge'

const execa = vi.hoisted(() => vi.fn())

vi.mock('execa', () => ({ execa }))
// The `/clear` settle delay is real time — collapse it so the clear-path test is fast.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }))

let prevTmux: string | undefined

beforeEach(() => {
  execa.mockReset()
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
    expect(cmd).toContain('Enter')
  })

  it('omits the clear step when clear is false', () => {
    const cmd = buildRemoteNudgeCommand('s', 'go', false)
    expect(cmd).not.toContain('/clear')
    expect(cmd).not.toContain('sleep')
  })

  it('types /clear with a settle beat before the nudge when clear is true', () => {
    const cmd = buildRemoteNudgeCommand('s', 'go', true)
    const clearAt = cmd.indexOf(sq('/clear'))
    const sleepAt = cmd.indexOf('sleep 0.6')
    const goAt = cmd.lastIndexOf(sq('go'))
    expect(clearAt).toBeGreaterThanOrEqual(0)
    // /clear is sent, then a sleep, then the nudge text — in that order
    expect(clearAt).toBeLessThan(sleepAt)
    expect(sleepAt).toBeLessThan(goAt)
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
    expect(events.some((e) => e.level === 'success')).toBe(true)
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
})
