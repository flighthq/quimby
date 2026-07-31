import type { AgentState } from '@quimbyhq/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const confirm = vi.hoisted(() => vi.fn())
const hasAgentSession = vi.hoisted(() => vi.fn(async () => true))
const nudgeAgentSession = vi.hoisted(() => vi.fn(async () => {}))
const info = vi.hoisted(() => vi.fn())

vi.mock('@clack/prompts', () => ({ confirm, isCancel: (v: unknown) => v === Symbol.for('cancel') }))
vi.mock('@quimbyhq/session', () => ({ hasAgentSession, nudgeAgentSession }))
vi.mock('@quimbyhq/utils', () => ({ logger: { info } }))

const { conflictNudgeCommand, offerConflictNudge } = await import('./conflictNudge')

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
