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

/**
 * A tracker that has already SIGHTED the inbox. The first sweep only records — it never announces —
 * so every test about announcing starts from here. {@link FIRST_ELIGIBLE} is the earliest moment
 * after that sighting at which a reminder may be delivered.
 */
async function sightedTracker() {
  const tracker = createInboxReminderTracker()
  await remindUnreadInboxes(dir, stateWith(), tracker, 0, silentReporter)
  return tracker
}

const FIRST_ELIGIBLE = REMIND_INTERVAL_MS + 1

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
    const tracker = await sightedTracker()
    await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE, reporter)
    expect(nudgeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ courier: 'parcel builder-a1 unprocessed in your inbox' }),
    )
  })

  // The sweep is a net for a LOST wake, and it shares no tracker with whoever carried the parcel —
  // a `quimby delegate` from the CLI, or a server wake still inside its bundle window. Announcing
  // on sight re-woke the agent seconds after that carrier already had, for the same parcel; it also
  // announced a deliberately ADVISORY parcel, undoing §6a for any agent with an otherwise clear
  // tray. So the first sighting is recorded and the carrier's own rule is left to govern it.
  it('records a first sighting instead of announcing it', async () => {
    await giveInbox('builder-a1')
    const tracker = createInboxReminderTracker()
    await remindUnreadInboxes(dir, stateWith(), tracker, 0)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
    expect(tracker.seen.get('review')?.known).toEqual(['builder-a1'])
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
    await remindUnreadInboxes(dir, stateWith(), await sightedTracker(), FIRST_ELIGIBLE)
    // Not forced — §7 must still be free to hold it for the one focused window.
    expect(nudgeAgentSession).toHaveBeenCalledWith(expect.not.objectContaining({ force: true }))
  })

  it('spaces reminders by the interval rather than nudging every poll cycle', async () => {
    await giveInbox('builder-a1')
    const tracker = await sightedTracker()
    await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE)
    await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE + REMIND_INTERVAL_MS - 1)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(1)

    await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE + REMIND_INTERVAL_MS + 1)
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
    const tracker = await sightedTracker()
    nudgeAgentSession.mockResolvedValue('held')

    await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE)
    await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE + 5_000) // one poll cycle later
    await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE + 10_000)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(3)
  })

  it('never lets holds exhaust the give-up cap — the focused-for-an-hour case', async () => {
    // Sitting in an agent's pane used to burn all three reminders without one reaching it, after
    // which quimby went silent and reported a perfectly healthy agent as stuck.
    await giveInbox('builder-a1')
    const tracker = await sightedTracker()
    nudgeAgentSession.mockResolvedValue('held')
    for (let i = 0; i < MAX_REMINDERS + 5; i++) {
      await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE + i * 5_000)
    }
    expect(nudgeAgentSession).toHaveBeenCalledTimes(MAX_REMINDERS + 5)

    // …and the moment the human looks away it lands, then normal spacing resumes.
    nudgeAgentSession.mockResolvedValue('sent')
    const delivered = nudgeAgentSession.mock.calls.length
    await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE + 100_000)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(delivered + 1)
    await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE + 105_000)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(delivered + 1)
  })

  it('narrates a hold once, not once per retry, so a watched pane is not spammed', async () => {
    await giveInbox('builder-a1')
    const tracker = await sightedTracker()
    nudgeAgentSession.mockResolvedValue('held')

    await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE)
    await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE + 5_000)
    await remindUnreadInboxes(dir, stateWith(), tracker, FIRST_ELIGIBLE + 10_000)

    const quiet = nudgeAgentSession.mock.calls.map(
      (c) => (c[0] as { quietHold?: boolean }).quietHold,
    )
    expect(quiet).toEqual([false, true, true])
  })

  it('does not count an attempt that found no session against the cap', async () => {
    await giveInbox('builder-a1')
    const tracker = createInboxReminderTracker()
    nudgeAgentSession.mockResolvedValue('no-session')
    for (let i = 0; i <= MAX_REMINDERS + 2; i++) {
      await remindUnreadInboxes(dir, stateWith(), tracker, i * REMIND_INTERVAL_MS * 2)
    }
    expect(nudgeAgentSession).toHaveBeenCalledTimes(MAX_REMINDERS + 2)
  })

  // The cap resets on DRAINAGE, not on arrival. It used to reset whenever the inbox changed, so a
  // single new parcel re-armed it — and an agent that never marked anything processed was poked
  // indefinitely while its tray only grew. That is the 300-parcel backlog case, and the reason
  // agents began dismissing the notice as "same notification about unreads".
  it('stops reminding when new parcels arrive but nothing is ever processed', async () => {
    await giveInbox('builder-a1')
    const tracker = createInboxReminderTracker()
    for (let i = 0; i <= MAX_REMINDERS + 1; i++) {
      await remindUnreadInboxes(dir, stateWith(), tracker, i * REMIND_INTERVAL_MS * 2)
    }
    expect(nudgeAgentSession).toHaveBeenCalledTimes(MAX_REMINDERS)

    // a new arrival is NOT evidence the agent is working — it must not re-arm the sweep
    await giveInbox('builder-a2')
    await remindUnreadInboxes(dir, stateWith(), tracker, 999 * REMIND_INTERVAL_MS)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(MAX_REMINDERS)
  })
})

// Two spam sources the SSH tilde fix exposed the moment this sweep started working: on a busy fleet
// the inbox changes every cycle, and a delivery already nudges its recipient.
describe('remindUnreadInboxes on a backlog', () => {
  it('names what is NEW since the last reminder, not just the total', async () => {
    await giveInbox('a-1', 'b-2', 'c-3')
    const tracker = createInboxReminderTracker()
    tracker.seen.set('review', {
      signature: 'a-1,b-2',
      remindedAt: 0,
      count: 1,
      known: ['a-1', 'b-2'],
    })
    await remindUnreadInboxes(dir, stateWith(), tracker, REMIND_INTERVAL_MS + 1, silentReporter, {})
    const courier = nudgeAgentSession.mock.calls[0][0] as unknown as { courier: string }
    expect(courier.courier).toContain('1 new parcel(s) since I last told you')
    expect(courier.courier).toContain('3 unprocessed in total')
  })

  it('gives up on a tray that never drains, even as new parcels arrive', async () => {
    await giveInbox('a-1', 'b-2')
    const tracker = createInboxReminderTracker()
    // reminded MAX_REMINDERS times already, and nothing it knew about has been processed
    tracker.seen.set('review', {
      signature: 'older',
      remindedAt: 0,
      count: MAX_REMINDERS,
      known: ['a-1'],
    })
    await remindUnreadInboxes(dir, stateWith(), tracker, REMIND_INTERVAL_MS + 1, silentReporter, {})
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })

  it('resumes reminding once the agent actually processes something', async () => {
    await giveInbox('b-2')
    const tracker = createInboxReminderTracker()
    // a-1 is gone from the tray — it was processed, which is evidence of life
    tracker.seen.set('review', {
      signature: 'older',
      remindedAt: 0,
      count: MAX_REMINDERS,
      known: ['a-1', 'b-2'],
    })
    await remindUnreadInboxes(dir, stateWith(), tracker, REMIND_INTERVAL_MS + 1, silentReporter, {})
    expect(nudgeAgentSession).toHaveBeenCalled()
  })
})

// Agents were answering "same notification about unreads, ignoring" — and they were right: a repeat
// restating the same total is information they already have. And a tray nobody drains was poked
// forever, because a single new arrival reset the give-up counter.
describe('remindUnreadInboxes pacing', () => {
  it('holds the interval even when the inbox changed, so a busy agent is not reminded every cycle', async () => {
    await giveInbox('a-1', 'b-2')
    const tracker = createInboxReminderTracker()
    // reminded a minute ago about a DIFFERENT inbox — previously any change bypassed the interval
    tracker.seen.set('review', { signature: 'old-parcel', remindedAt: 1_000, count: 1, known: [] })
    await remindUnreadInboxes(dir, stateWith(), tracker, 1_000 + 60_000, silentReporter, {})
    expect(nudgeAgentSession).not.toHaveBeenCalled()
    expect(tracker.seen.get('review')?.remindedAt).toBe(1_000)
  })

  it('still reminds once the interval has genuinely elapsed', async () => {
    await giveInbox('a-1')
    const tracker = createInboxReminderTracker()
    tracker.seen.set('review', { signature: 'old-parcel', remindedAt: 1_000, count: 1, known: [] })
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
