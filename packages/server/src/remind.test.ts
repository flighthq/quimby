import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { getAgentHandoffInReceivedDir } from '@quimbyhq/paths'
import { collectingReporter, silentReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAgentSessionState = vi.hoisted(() => vi.fn(async () => 'running' as string))
const nudgeAgentSession = vi.hoisted(() =>
  vi.fn(async (_opts: { quietHold?: boolean }): Promise<string> => 'sent'),
)

vi.mock('@quimbyhq/session', () => ({ getAgentSessionState, nudgeAgentSession }))

const {
  createInboxReminderTracker,
  MAX_REMINDERS,
  noteInboxDelivery,
  REMIND_INTERVAL_MS,
  remindUnreadInboxes,
} = await import('./remind')

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
  nudgeAgentSession.mockResolvedValue('sent')
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

  it('retries a held nudge next cycle instead of waiting out the interval', async () => {
    // A hold delivered nothing, so the interval — which spaces out DELIVERED reminders — must not
    // gate the retry, or the wake waits the full 10 minutes the retry exists to avoid.
    await giveInbox('builder-a1')
    const tracker = createInboxReminderTracker()
    nudgeAgentSession.mockResolvedValue('held')

    await remindUnreadInboxes(dir, stateWith(), tracker, 0)
    await remindUnreadInboxes(dir, stateWith(), tracker, 5_000) // one poll cycle later
    await remindUnreadInboxes(dir, stateWith(), tracker, 10_000)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(3)
  })

  it('never lets holds exhaust the give-up cap — the focused-for-an-hour case', async () => {
    // Sitting in an agent's pane used to burn all three reminders without one reaching it, after
    // which quimby went silent and reported a perfectly healthy agent as stuck.
    await giveInbox('builder-a1')
    const tracker = createInboxReminderTracker()
    nudgeAgentSession.mockResolvedValue('held')
    for (let i = 0; i < MAX_REMINDERS + 5; i++) {
      await remindUnreadInboxes(dir, stateWith(), tracker, i * 5_000)
    }
    expect(nudgeAgentSession).toHaveBeenCalledTimes(MAX_REMINDERS + 5)

    // …and the moment the human looks away it lands, then normal spacing resumes.
    nudgeAgentSession.mockResolvedValue('sent')
    const delivered = nudgeAgentSession.mock.calls.length
    await remindUnreadInboxes(dir, stateWith(), tracker, 100_000)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(delivered + 1)
    await remindUnreadInboxes(dir, stateWith(), tracker, 105_000)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(delivered + 1)
  })

  it('narrates a hold once, not once per retry, so a watched pane is not spammed', async () => {
    await giveInbox('builder-a1')
    const tracker = createInboxReminderTracker()
    nudgeAgentSession.mockResolvedValue('held')

    await remindUnreadInboxes(dir, stateWith(), tracker, 0)
    await remindUnreadInboxes(dir, stateWith(), tracker, 5_000)
    await remindUnreadInboxes(dir, stateWith(), tracker, 10_000)

    const quiet = nudgeAgentSession.mock.calls.map(
      (c) => (c[0] as { quietHold?: boolean }).quietHold,
    )
    expect(quiet).toEqual([false, true, true])
  })

  it('does not count an attempt that found no session against the cap', async () => {
    await giveInbox('builder-a1')
    const tracker = createInboxReminderTracker()
    nudgeAgentSession.mockResolvedValue('no-session')
    for (let i = 0; i < MAX_REMINDERS + 2; i++) {
      await remindUnreadInboxes(dir, stateWith(), tracker, i * REMIND_INTERVAL_MS * 2)
    }
    expect(nudgeAgentSession).toHaveBeenCalledTimes(MAX_REMINDERS + 2)
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

// Two spam sources the SSH tilde fix exposed the moment this sweep started working: on a busy fleet
// the inbox changes every cycle, and a delivery already nudges its recipient.
describe('remindUnreadInboxes pacing', () => {
  it('holds the interval even when the inbox changed, so a busy agent is not reminded every cycle', async () => {
    await giveInbox('a-1', 'b-2')
    const tracker = createInboxReminderTracker()
    // reminded a minute ago about a DIFFERENT inbox — previously any change bypassed the interval
    tracker.seen.set('review', { signature: 'old-parcel', remindedAt: 1_000, count: 1 })
    await remindUnreadInboxes(dir, stateWith(), tracker, 1_000 + 60_000, silentReporter, {})
    expect(nudgeAgentSession).not.toHaveBeenCalled()
    expect(tracker.seen.get('review')?.remindedAt).toBe(1_000)
  })

  it('still reminds once the interval has genuinely elapsed', async () => {
    await giveInbox('a-1')
    const tracker = createInboxReminderTracker()
    tracker.seen.set('review', { signature: 'old-parcel', remindedAt: 1_000, count: 1 })
    await remindUnreadInboxes(
      dir,
      stateWith(),
      tracker,
      1_000 + REMIND_INTERVAL_MS + 1,
      silentReporter,
      {},
    )
    expect(nudgeAgentSession).toHaveBeenCalled()
  })

  // The reported double message: a `delegated task <parcel>` wake, then a `parcel <parcel> unread`
  // wake for the SAME parcel in the same minute. A first sighting has no previous entry, so the
  // interval could not apply — recording the delivery as an announcement is what closes it.
  it('does not re-announce an inbox a delivery just woke the agent about', async () => {
    await giveInbox('principal-d9188a02')
    const tracker = createInboxReminderTracker()
    noteInboxDelivery(tracker, 'review', 10_000_000)
    await remindUnreadInboxes(dir, stateWith(), tracker, 10_000_000 + 5_000, silentReporter, {})
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })

  it('does re-announce once the interval has passed since that delivery', async () => {
    await giveInbox('principal-d9188a02')
    const tracker = createInboxReminderTracker()
    noteInboxDelivery(tracker, 'review', 10_000_000)
    await remindUnreadInboxes(
      dir,
      stateWith(),
      tracker,
      10_000_000 + REMIND_INTERVAL_MS + 1,
      silentReporter,
      {},
    )
    expect(nudgeAgentSession).toHaveBeenCalled()
  })
})
