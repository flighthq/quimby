import type { AgentState } from '@quimbyhq/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const confirm = vi.hoisted(() => vi.fn())
const hasAgentSession = vi.hoisted(() => vi.fn(async () => true))
const nudgeAgentSession = vi.hoisted(() => vi.fn(async () => {}))
const info = vi.hoisted(() => vi.fn())

vi.mock('@clack/prompts', () => ({ confirm, isCancel: (v: unknown) => v === Symbol.for('cancel') }))
vi.mock('@quimbyhq/session', () => ({ hasAgentSession, nudgeAgentSession }))
vi.mock('@quimbyhq/utils', () => ({ logger: { info } }))

const {
  applyBaseNudgeCommand,
  conflictNudgeCommand,
  offerApplyBaseNudge,
  offerApplyBaseNudgeAll,
  offerConflictNudge,
} = await import('./conflictNudge')

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

// `sync --all` deferring several agents used to print a count and stop, so the sweep looked broken
// next to a single `quimby sync <agent>` — which defers identically and only LOOKS successful
// because it goes on to offer this nudge. One prompt for the set closes that gap without
// reintroducing a prompt per agent.
describe('offerApplyBaseNudgeAll', () => {
  const two = [
    { agent, displayName: 'foreman' },
    { agent: { id: 'b2', name: 'builder2', tmux: true } as AgentState, displayName: 'builder2' },
  ]

  it('asks once for the whole set, then nudges each agent', async () => {
    setTTY(true)
    confirm.mockResolvedValue(true)

    expect(await offerApplyBaseNudgeAll({ agents: two, whenNonInteractive: 'print' })).toBe(2)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(2)
    expect(nudgeAgentSession).toHaveBeenCalledWith(expect.objectContaining({ force: true }))
  })

  it('names the agents in the prompt, so it is clear what is being woken', async () => {
    setTTY(true)
    confirm.mockResolvedValue(true)
    await offerApplyBaseNudgeAll({ agents: two, whenNonInteractive: 'print' })
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('foreman, builder2') }),
    )
  })

  it('nudges nothing and prints the per-agent commands when declined', async () => {
    setTTY(true)
    confirm.mockResolvedValue(false)
    expect(await offerApplyBaseNudgeAll({ agents: two, whenNonInteractive: 'print' })).toBe(0)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(expect.stringContaining('quimby sync foreman'))
  })

  it('only prints when there is no TTY', async () => {
    setTTY(false)
    expect(await offerApplyBaseNudgeAll({ agents: two, whenNonInteractive: 'print' })).toBe(0)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })

  // A stopped agent cannot be typed into and applies the base on its next run; it must be named
  // rather than silently dropped from the set the prompt covers.
  it('reports stopped agents separately and prompts only for the live ones', async () => {
    setTTY(true)
    confirm.mockResolvedValue(true)
    hasAgentSession.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    expect(await offerApplyBaseNudgeAll({ agents: two, whenNonInteractive: 'print' })).toBe(1)
    expect(info).toHaveBeenCalledWith(expect.stringContaining('foreman'))
    expect(nudgeAgentSession).toHaveBeenCalledTimes(1)
  })

  it('does nothing at all when no deferred agent is running', async () => {
    setTTY(true)
    hasAgentSession.mockResolvedValue(false)
    expect(await offerApplyBaseNudgeAll({ agents: two, whenNonInteractive: 'print' })).toBe(0)
    expect(confirm).not.toHaveBeenCalled()
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
