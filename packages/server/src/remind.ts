import { readInboxParcelNames } from '@quimbyhq/handoff'
import { remoteAgentHandoffInReceivedDir } from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { getAgentSessionState, nudgeAgentSession } from '@quimbyhq/session'
import { getSSHTransport, sp } from '@quimbyhq/transport'
import type { AgentState, QuimbyConfig, QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { getFocusGraceSeconds, resolveAgentFocusPolicy } from '@quimbyhq/workspace'

export interface InboxReminderTracker {
  /**
   * Per agent: the inbox it was last reminded about, when, and how many times it was actually
   * ANNOUNCED. `heldReported` records that a deferral was already narrated, so a retry every poll
   * cycle does not repeat the notice (or re-flash the pane being typed in).
   */
  seen: Map<
    string,
    {
      signature: string
      remindedAt: number
      count: number
      heldReported?: boolean
      /** The parcels this agent was last told about, so the next notice can name only the new ones. */
      known: string[]
    }
  >
}

export function createInboxReminderTracker(): InboxReminderTracker {
  return { seen: new Map() }
}

/**
 * Record that a delivery just woke `name` about its inbox — which is an announcement of that inbox,
 * so the reminder interval should start from here.
 *
 * Without this the first parcel into an empty inbox produced two wakes seconds apart: the delivery
 * nudge, then the reminder on the very next cycle, because a first sighting has no previous entry
 * for the interval to apply to. Observed as a `delegated task <parcel>` and a `parcel <parcel>
 * unread in your inbox` for the SAME parcel in the same minute.
 *
 * Treating a delivery as an announcement collapses both the same-cycle and the next-cycle case into
 * the one rule that already exists, rather than adding a second mechanism beside it.
 */
export function noteInboxDelivery(tracker: InboxReminderTracker, name: string, now: number): void {
  tracker.seen.set(name, { signature: '', remindedAt: now, count: 0, known: [] })
}

/**
 * Re-announce parcels an idle agent still hasn't read — the safety net for an unattended fleet.
 *
 * Delivery is durable but the *wake* is not: a nudge can be lost to a dead session, a send-keys
 * failure, a coalesce that fired while the agent was mid-restart, or simply a parcel that never
 * warranted an interrupt. Any of those strands the work until a human looks, which overnight means
 * until morning. Since an unwoken agent is a worse failure than a duplicate nudge, this sweeps for
 * agents sitting on unread parcels and pokes them again.
 *
 * Three bounds keep it from becoming noise: a **stopped** session is skipped (nothing to type
 * into) while a live one defers to §7, which holds only for the window the human is typing in
 * (flashing its status line instead of injecting), reminders are spaced by
 * {@link REMIND_INTERVAL_MS}, and an inbox that does not change is reminded at most
 * {@link MAX_REMINDERS} times before the sweep concludes the agent is stuck and says so instead of
 * poking it all night.
 */
export async function remindUnreadInboxes(
  repoRoot: string,
  state: Readonly<QuimbyState>,
  tracker: InboxReminderTracker,
  now: number,
  reporter: Reporter = silentReporter,
  config: Readonly<QuimbyConfig> = {},
): Promise<void> {
  for (const [name, agent] of Object.entries(state.agents)) {
    if (agent.enabled === false) continue
    const unread = await readUnreadParcels(repoRoot, state.id, agent)
    const signature = unread.join(',')

    if (unread.length === 0) {
      tracker.seen.delete(name)
      continue
    }

    const previous = tracker.seen.get(name)
    const sameInbox = previous?.signature === signature
    // A previously HELD attempt is always eligible to retry: the interval spaces out *delivered*
    // reminders, and a hold delivered nothing. Without this exemption the retry would itself be
    // held off for REMIND_INTERVAL_MS, which is the delay the retry exists to remove.
    const retryingHold = Boolean(sameInbox && previous.heldReported)

    // The INTERVAL applies whatever the inbox contains. Gating it on `sameInbox` meant any change
    // reset it — and on a working fleet the inbox changes constantly, because every delivery adds
    // a parcel. So a busy agent was reminded on nearly every poll cycle instead of every ten
    // minutes: observed at 09:43:48, 09:44:54, 09:45:23 for one agent whose count merely went
    // 32 → 33 → 32. The interval exists to bound how often an agent is interrupted, and that
    // bound cannot depend on what arrived in the meantime.
    if (previous && !retryingHold && now - previous.remindedAt < REMIND_INTERVAL_MS) continue

    // The give-up CAP keys on DRAINAGE: did the agent process anything it already knew about?
    // Keying it on an unchanged signature meant a single new arrival reset the counter, so an agent
    // that never marks anything processed was poked forever while its tray only grew — which is
    // exactly the state a 300-parcel backlog produces, and why agents started answering "same
    // notification about unreads, ignoring". They were right: nothing had changed for them.
    const drained = previous ? previous.known.some((p) => !unread.includes(p)) : true
    if (previous && !drained && previous.count >= MAX_REMINDERS) continue

    // Only a STOPPED session is skipped — it has no prompt to type into, and the work is on disk
    // for its next launch. Everything live is attempted, and §7 (inside nudgeAgentSession) decides
    // whether to inject: it holds only for the one window the human is actually typing in, and
    // flashes that window's status line instead. Filtering on `attached` here was the same wrong
    // predicate §7 itself was fixed for — an SSH agent's dashboard tab is a real `tmux attach`, so
    // every agent in an open dashboard reads `attached` and the safety net silently never fired.
    if ((await getAgentSessionState(agent)) === 'stopped') continue

    // Attempt FIRST, record only if it actually landed. Recording up front counted a held nudge as
    // an announcement, so sitting in an agent's pane for half an hour burned all three reminders
    // without a single one reaching it — and quimby then declared a perfectly healthy agent stuck.
    const heldBefore = retryingHold
    if (!heldBefore) {
      reporter.info(
        `[remind] "${name}" still has ${unread.length} unread parcel(s) — re-announcing`,
      )
    }
    const outcome = await nudgeAgentSession({
      agent,
      displayName: name,
      // "unprocessed", never "unread": the tray holds everything not yet marked done, INCLUDING
      // parcels the agent has read. Telling an agent it has 374 unread items it knows it has read
      // is false from where it sits, and a claim it can dismiss. Naming what is NEW since the last
      // reminder is the part it cannot already know.
      courier: reminderCourier(unread, previous?.known ?? []),
      whenFocused: resolveAgentFocusPolicy(config, state, name),
      focusGraceSeconds: getFocusGraceSeconds(config),
      projectId: state.id,
      quietHold: heldBefore,
      reporter,
    })

    if (outcome === 'held') {
      // Deferred, not delivered: leave `remindedAt` and `count` untouched so the interval check
      // passes again next cycle and this retries — landing about one poll cycle after the human
      // stops typing (the focus grace decides when that is), instead of up to REMIND_INTERVAL_MS
      // later, or never once the cap was spent.
      tracker.seen.set(name, {
        signature,
        remindedAt: previous?.signature === signature ? previous.remindedAt : 0,
        count: previous?.signature === signature ? previous.count : 0,
        heldReported: true,
        known: previous?.known ?? [],
      })
      continue
    }
    // Anything that never reached the agent (no session, refused) is likewise not an announcement.
    if (outcome !== 'sent') continue

    // Counts a delivered reminder that the agent did NOT act on. Resetting only when it actually
    // processed something is what lets the sweep give up on a tray nobody is draining.
    const count = previous && !drained ? previous.count + 1 : 1
    tracker.seen.set(name, { signature, remindedAt: now, count, known: unread })

    if (count >= MAX_REMINDERS) {
      reporter.warn(
        `[remind] "${name}" has not processed anything across ${count} reminders and is holding ` +
          `${unread.length} parcel(s). No further reminders until it drains some. If the tray is ` +
          'simply too deep to clear one at a time, `./agent.sh inbox done --all` empties it.',
      )
    }
  }
}

/**
 * What a reminder actually says. A repeat that restates the same total is information the agent
 * already has, and it correctly ignores it — so lead with what is NEW since it was last told.
 */
function reminderCourier(unread: readonly string[], known: readonly string[]): string {
  const fresh = unread.filter((p) => !known.includes(p))
  if (unread.length === 1) return `parcel ${unread[0]} unprocessed in your inbox`
  if (fresh.length > 0 && fresh.length < unread.length) {
    return (
      `${fresh.length} new parcel(s) since I last told you (${unread.length} unprocessed in total) — ` +
      '`./agent.sh inbox` to triage, `inbox done --all` to clear the rest'
    )
  }
  return (
    `${unread.length} unprocessed parcels in your inbox — \`./agent.sh inbox\` to triage, ` +
    '`inbox done --all` to clear them'
  )
}

/** How long an unread inbox sits before the sweep re-announces it. */
export const REMIND_INTERVAL_MS = 10 * 60 * 1000

/** Reminders for one unchanged inbox before the sweep gives up on it. */
export const MAX_REMINDERS = 3

// The agent's unprocessed parcels, wherever it lives. Best-effort: an unreachable SSH host reads as
// "nothing unread" rather than aborting the sweep for every other agent.
async function readUnreadParcels(
  repoRoot: string,
  projectId: string,
  agent: Readonly<AgentState>,
): Promise<string[]> {
  if (!isSSH(agent.location)) {
    return readInboxParcelNames(repoRoot, agent.id).catch(() => [])
  }
  const dir = remoteAgentHandoffInReceivedDir(projectId, agent.id, agent.location.base)
  try {
    // `sp`, not `sq`: the path starts with `~/`, and quoting it whole makes the remote shell
    // read a literal `~` directory — which is always empty, so this sweep silently concluded
    // every SSH agent's inbox was clear and never re-announced an unread parcel to one.
    const out = await getSSHTransport(agent.location).exec(`ls -1 ${sp(dir)} 2>/dev/null || true`)
    return out.split('\n').filter(Boolean).sort()
  } catch {
    return []
  }
}
