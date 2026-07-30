import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { getAgentHandoffInReceivedDir } from '@quimbyhq/paths'
import { collectingReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAgentSessionState = vi.hoisted(() => vi.fn(async () => 'running' as string))
const nudgeAgentSession = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@quimbyhq/session', () => ({ getAgentSessionState, nudgeAgentSession }))

const { createInboxReminderTracker, MAX_REMINDERS, REMIND_INTERVAL_MS, remindUnreadInboxes } =
  await import('./remind')

let dir: string

function stateWith(): QuimbyState {
  return {
    id: 'proj',
    agents: { review: { id: 'review-id', name: 'review', location: { type: 'local' } } },
  } as unknown as QuimbyState
}

async function giveInbox(...parcels: string[]): Promise<void> {
  for (const p of parcels) {
    await mkdir(join(getAgentHandoffInReceivedDir(dir, 'review-id'), p), { recursive: true })
  }
}

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-remind-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
  getAgentSessionState.mockReset()
  getAgentSessionState.mockResolvedValue('running')
  nudgeAgentSession.mockReset()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createInboxReminderTracker', () => {
  it('starts empty', () => {
    expect(createInboxReminderTracker().seen.size).toBe(0)
  })
})

describe('remindUnreadInboxes', () => {
  it('re-announces an unread inbox on an idle agent', async () => {
    await giveInbox('builder-a1')
    const { reporter } = collectingReporter()
    await remindUnreadInboxes(dir, stateWith(), createInboxReminderTracker(), 0, reporter)
    expect(nudgeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ courier: 'parcel builder-a1 unread in your inbox' }),
    )
  })

  it('says nothing when the inbox is empty', async () => {
    await remindUnreadInboxes(dir, stateWith(), createInboxReminderTracker(), 0)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })

  it('never reminds a stopped agent — there is no prompt to type into', async () => {
    await giveInbox('builder-a1')
    getAgentSessionState.mockResolvedValue('stopped')
    await remindUnreadInboxes(dir, stateWith(), createInboxReminderTracker(), 0)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })

  it('reminds an ATTACHED agent, leaving the hold to §7', async () => {
    // An SSH agent's dashboard tab is a real `tmux attach`, so every agent in an open dashboard
    // reads `attached`. Skipping those here silently disabled the safety net for a whole fleet;
    // nudgeAgentSession already holds for the one window the human is typing in.
    await giveInbox('builder-a1')
    getAgentSessionState.mockResolvedValue('attached')
    await remindUnreadInboxes(dir, stateWith(), createInboxReminderTracker(), 0)
    // Not forced — §7 must still be free to hold it for the one focused window.
    expect(nudgeAgentSession).toHaveBeenCalledWith(expect.not.objectContaining({ force: true }))
  })

  it('spaces reminders by the interval rather than nudging every poll cycle', async () => {
    await giveInbox('builder-a1')
    const tracker = createInboxReminderTracker()
    await remindUnreadInboxes(dir, stateWith(), tracker, 0)
    await remindUnreadInboxes(dir, stateWith(), tracker, REMIND_INTERVAL_MS - 1)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(1)

    await remindUnreadInboxes(dir, stateWith(), tracker, REMIND_INTERVAL_MS + 1)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(2)
  })

  it('gives up on an unchanged inbox after the cap, instead of poking all night', async () => {
    await giveInbox('builder-a1')
    const tracker = createInboxReminderTracker()
    for (let i = 0; i <= MAX_REMINDERS + 2; i++) {
      await remindUnreadInboxes(dir, stateWith(), tracker, i * REMIND_INTERVAL_MS * 2)
    }
    expect(nudgeAgentSession).toHaveBeenCalledTimes(MAX_REMINDERS)
  })

  it('resets the cap when the inbox changes, so new work always gets announced', async () => {
    await giveInbox('builder-a1')
    const tracker = createInboxReminderTracker()
    for (let i = 0; i <= MAX_REMINDERS + 1; i++) {
      await remindUnreadInboxes(dir, stateWith(), tracker, i * REMIND_INTERVAL_MS * 2)
    }
    expect(nudgeAgentSession).toHaveBeenCalledTimes(MAX_REMINDERS)

    await giveInbox('builder-a2')
    await remindUnreadInboxes(dir, stateWith(), tracker, 999 * REMIND_INTERVAL_MS)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(MAX_REMINDERS + 1)
    expect(nudgeAgentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ courier: '2 unread parcels in your inbox' }),
    )
  })
})
