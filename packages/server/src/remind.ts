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
    { signature: string; remindedAt: number; count: number; heldReported?: boolean }
  >
}

export function createInboxReminderTracker(): InboxReminderTracker {
  return { seen: new Map() }
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
    if (sameInbox && !retryingHold && now - previous.remindedAt < REMIND_INTERVAL_MS) continue
    if (sameInbox && previous.count >= MAX_REMINDERS) continue

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
      courier:
        unread.length === 1
          ? `parcel ${unread[0]} unread in your inbox`
          : `${unread.length} unread parcels in your inbox`,
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
      })
      continue
    }
    // Anything that never reached the agent (no session, refused) is likewise not an announcement.
    if (outcome !== 'sent') continue

    const count = sameInbox ? previous.count + 1 : 1
    tracker.seen.set(name, { signature, remindedAt: now, count })

    if (count >= MAX_REMINDERS) {
      reporter.warn(
        `[remind] "${name}" has ignored ${unread.length} parcel(s) across ${count} delivered ` +
          'reminders — it may be stuck or out of context. No further reminders until its inbox ' +
          'changes.',
      )
    }
  }
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
