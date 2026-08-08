import type { AgentState } from '@quimbyhq/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const confirm = vi.hoisted(() => vi.fn())
const hasAgentSession = vi.hoisted(() => vi.fn(async () => true))
const nudgeAgentSession = vi.hoisted(() => vi.fn(async () => {}))
const info = vi.hoisted(() => vi.fn())

vi.mock('@clack/prompts', () => ({ confirm, isCancel: (v: unknown) => v === Symbol.for('cancel') }))
vi.mock('@quimbyhq/session', () => ({ hasAgentSession, nudgeAgentSession }))
vi.mock('@quimbyhq/utils', () => ({ logger: { info } }))

const { applyBaseNudgeCommand, conflictNudgeCommand, offerApplyBaseNudge, offerConflictNudge } =
  await import('./conflictNudge')

const agent = { id: 'a1', name: 'builder', tmux: true } as AgentState

let prevOut: boolean | undefined
let prevIn: boolean | undefined

function setTTY(value: boolean): void {
  process.stdout.isTTY = value
  process.stdin.isTTY = value
}

beforeEach(() => {
  prevOut = process.stdout.isTTY
  prevIn = process.stdin.isTTY
  confirm.mockReset()
  hasAgentSession.mockReset()
  hasAgentSession.mockResolvedValue(true)
  nudgeAgentSession.mockReset()
  info.mockReset()
})

afterEach(() => {
  process.stdout.isTTY = prevOut as boolean
  process.stdin.isTTY = prevIn as boolean
})

describe('applyBaseNudgeCommand', () => {
  it('uses --raw, since this is an ephemeral poke rather than a durable assignment', () => {
    const cmd = applyBaseNudgeCommand('builder')
    expect(cmd).toContain('quimby nudge builder --raw')
    expect(cmd).toContain('./agent.sh rebase')
  })
})

// The deliver-vs-apply split made the CONFLICT offer unreachable for the common case: a routine
// sync no longer attempts the rebase, so it cannot fail, so that prompt never appears. Without
// this offer, syncing a busy agent delivers the base and leaves nobody able to tell it to take one.
describe('offerApplyBaseNudge', () => {
  it('nudges (forced) when the user accepts', async () => {
    setTTY(true)
    confirm.mockResolvedValue(true)

    expect(
      await offerApplyBaseNudge({ agent, displayName: 'builder', whenNonInteractive: 'print' }),
    ).toBe(true)
    expect(nudgeAgentSession).toHaveBeenCalledWith(expect.objectContaining({ force: true }))
    // it must name the TOOL, not a raw git rebase — the tool is what refuses on a dirty tree
    expect(nudgeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ courier: expect.stringContaining('./agent.sh rebase') }),
    )
  })

  it('only prints when there is no TTY — waking an agent stays the user’s call', async () => {
    setTTY(false)
    expect(
      await offerApplyBaseNudge({ agent, displayName: 'builder', whenNonInteractive: 'print' }),
    ).toBe(false)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(expect.stringContaining('quimby nudge builder --raw'))
  })

  it('prints the paste-able command when the user declines', async () => {
    setTTY(true)
    confirm.mockResolvedValue(false)
    expect(
      await offerApplyBaseNudge({ agent, displayName: 'builder', whenNonInteractive: 'print' }),
    ).toBe(false)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(expect.stringContaining('./agent.sh rebase'))
  })

  // A stopped agent has no prompt to type into, and it will apply the base itself on next run —
  // so this reports that rather than implying the base is stuck.
  it('reports how it resolves itself when the agent is not running', async () => {
    hasAgentSession.mockResolvedValue(false)
    expect(
      await offerApplyBaseNudge({ agent, displayName: 'builder', whenNonInteractive: 'print' }),
    ).toBe(false)
    expect(info).toHaveBeenCalledWith(expect.stringContaining("isn't running"))
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })
})

describe('conflictNudgeCommand', () => {
  it('is a ready-to-paste nudge naming the ref to rebase onto', () => {
    expect(conflictNudgeCommand('builder', 'main')).toContain(
      'quimby nudge builder -m "rebase onto origin/main and resolve conflicts"',
    )
  })
})

describe('offerConflictNudge', () => {
  it('nudges (forced) when the user accepts the prompt', async () => {
    setTTY(true)
    confirm.mockResolvedValue(true)

    expect(
      await offerConflictNudge({
        agent,
        displayName: 'builder',
        syncRef: 'main',
        whenNonInteractive: 'print',
      }),
    ).toBe(true)
    // forced: this is the answer to a command the user just ran, not a background courier
    expect(nudgeAgentSession).toHaveBeenCalledWith(expect.objectContaining({ force: true }))
    expect(nudgeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ courier: 'rebase onto origin/main and resolve conflicts' }),
    )
  })

  it('prints the command instead when the user declines', async () => {
    setTTY(true)
    confirm.mockResolvedValue(false)

    expect(
      await offerConflictNudge({
        agent,
        displayName: 'builder',
        syncRef: 'main',
        whenNonInteractive: 'print',
      }),
    ).toBe(false)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
    expect(info.mock.calls.flat().join(' ')).toContain('quimby nudge builder')
  })

  it('never wakes a conflicted agent behind your back when non-interactive and "print"', async () => {
    setTTY(false)

    expect(
      await offerConflictNudge({
        agent,
        displayName: 'builder',
        syncRef: 'main',
        whenNonInteractive: 'print',
      }),
    ).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })

  it('fires unprompted when non-interactive and "nudge" (merge keeps its scripted behavior)', async () => {
    setTTY(false)

    expect(
      await offerConflictNudge({
        agent,
        displayName: 'builder',
        syncRef: 'main',
        whenNonInteractive: 'nudge',
      }),
    ).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(nudgeAgentSession).toHaveBeenCalled()
  })

  it('reports how to start a stopped agent rather than prompting for a session that isn’t there', async () => {
    setTTY(true)
    hasAgentSession.mockResolvedValue(false)

    expect(
      await offerConflictNudge({
        agent,
        displayName: 'builder',
        syncRef: 'main',
        whenNonInteractive: 'nudge',
      }),
    ).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(nudgeAgentSession).not.toHaveBeenCalled()
    expect(info.mock.calls.flat().join(' ')).toContain('quimby start builder')
  })
})
