import { readdir, stat } from 'node:fs/promises'

import { getAgentAttestation } from '@quimbyhq/agent'
import {
  dispatchOutbox,
  passiveDeliveryNotice,
  pickupRemoteOutbox,
  readOutboxRecipients,
} from '@quimbyhq/handoff'
import { getAgentHandoffOutQueuedRecipientDir } from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { nudgeAgentSession } from '@quimbyhq/session'
import type { AgentState, NudgePolicy, QuimbyConfig, QuimbyState } from '@quimbyhq/types'
import { getFocusGraceSeconds, getWakeBundleMs, resolveAgentFocusPolicy } from '@quimbyhq/workspace'
import { join } from 'pathe'

export interface OutboxDispatchTracker {
  seen: Map<string, number>
  done: Set<string>
}

/**
 * Wakes waiting to be sent, held across poll cycles so a burst becomes one nudge.
 *
 * Coalescing within a single cycle was never enough: parcels arriving in consecutive cycles woke the
 * recipient once per cycle, and each wake costs that agent a turn of context. Holding a pending wake
 * for a short window lets everything arriving inside it join, so five parcels over twenty seconds
 * cost one interruption instead of five.
 *
 * Only the WAKE waits. Parcels are delivered to the inbox immediately, as before — so nothing is
 * ever stranded by a server that stops mid-window, and the reminder sweep remains the net for a
 * wake that is lost.
 */
export interface WakeBundler {
  pending: Map<
    string,
    { agent: AgentState; descriptors: string[]; senders: Set<string>; queuedAt: number }
  >
}

export function createWakeBundler(): WakeBundler {
  return { pending: new Map() }
}

export async function autoDispatchOutboxes(
  repoRoot: string,
  state: Readonly<QuimbyState>,
  tracker: OutboxDispatchTracker,
  reporter: Reporter = silentReporter,
  defaultNudge: NudgePolicy = 'directed',
  config: Readonly<QuimbyConfig> = {},
  bundler: WakeBundler = createWakeBundler(),
  now: number = Date.now(),
): Promise<ReadonlySet<string>> {
  // §7a: coalesce this cycle's interrupting deliveries into ONE nudge per recipient — N parcels
  // arriving in a poll window wake the recipient once (fewer tokens, fewer injections) rather than
  // N times. Delivery stays per-parcel and immediate; only the wake is batched.
  // Carried across cycles by the caller, so a burst spread over several polls lands as one wake.
  const pending = bundler.pending
  for (const sender of Object.keys(state.agents)) {
    const senderAgent = state.agents[sender]
    const senderId = senderAgent.id
    // SSH agents author their outbox on the remote host; pick it up so the local reads
    // below (recipients, settle-debounce mtimes) see it. rsync preserves mtimes, so the
    // debounce still observes genuine stability across cycles. An unreachable host must
    // not abort the pass for every other agent, so skip this sender for the cycle.
    try {
      await pickupRemoteOutbox(repoRoot, senderAgent, state.id)
    } catch {
      continue
    }
    const recipients = await readOutboxRecipients(repoRoot, senderId)
    const present = new Set<string>()
    const stable: string[] = []

    const mtimes = new Map<string, number>()
    for (const recipient of recipients) {
      const key = `${sender}/${recipient}`
      present.add(key)
      const mtime = await outboxDraftMtime(repoRoot, senderId, recipient)
      if (mtime === null) continue
      mtimes.set(recipient, mtime)
      if (classifyOutboxDraft(tracker, key, mtime) === 'dispatch') stable.push(recipient)
    }

    for (const key of [...tracker.seen.keys()]) {
      if (key.startsWith(`${sender}/`) && !present.has(key)) tracker.seen.delete(key)
    }

    if (stable.length === 0) continue

    reporter.info(`[auto-dispatch] "${sender}" → ${stable.join(', ')}`)
    // Embed the code source's attestation in the carried parcel — the hands-off channel is exactly
    // where the recipient most needs it; without this the server-carried parcel would lose it.
    const results = await dispatchOutbox({
      state,
      repoRoot,
      sender,
      recipients: stable,
      defaultNudge,
      resolveAttestation: (name) =>
        state.agents[name]
          ? getAgentAttestation(repoRoot, state.id, state.agents[name])
          : Promise.resolve(null),
    })
    for (const result of results) {
      if (result.status === 'delivered') {
        const fileSuffix = result.files?.length ? ` +${result.files.length} file(s)` : ''
        reporter.success(
          `  delivered "${sender}" → "${result.recipient}" (${result.parcelName})${fileSuffix}`,
        )
        if (result.skippedFiles?.length) {
          reporter.warn(
            `  NOT carried: ${result.skippedFiles.join(', ')} — a parcel cannot hold a file with ` +
              'that name (or a directory). Rename the attachment and re-send.',
          )
        }
        // §6a: only a directed / escalation / reply parcel interrupts. Advisory parcels land
        // passively (the recipient reads them on its own turn), so no nudge is accrued for them —
        // but a REFUSED interrupt is reported, or the operator just sees a quiet recipient.
        // Say why nothing woke — in `serve` above all, where a silent delivery is the only thing
        // the operator sees and is indistinguishable from a broken courier.
        if (!result.interrupts) {
          const notice = `  ${passiveDeliveryNotice(sender, result)}`
          if (result.downgraded) reporter.warn(notice)
          else reporter.info(notice)
        }
        const recip = state.agents[result.recipient]
        if (recip && result.interrupts && result.parcelName) {
          const kind = result.escalation
            ? 'escalation'
            : result.userDirected
              ? 'delegated task'
              : 'parcel'
          const entry = pending.get(result.recipient) ?? {
            agent: recip,
            descriptors: [],
            senders: new Set<string>(),
            // The window is measured from the FIRST parcel of a burst, not the latest — otherwise a
            // steady trickle keeps resetting the timer and the wake never fires at all.
            queuedAt: now,
          }
          entry.descriptors.push(`${kind} ${result.parcelName} from ${sender}`)
          entry.senders.add(sender)
          pending.set(result.recipient, entry)
        }
      } else if (result.status === 'busy') {
        // Another process is carrying this exact parcel. Forget the attempt so the unchanged draft
        // is reconsidered next cycle — if the other side finishes, the draft is gone and this is a
        // no-op; if it failed, this cycle picks it up.
        forgetOutboxAttempt(tracker, `${sender}/${result.recipient}`, mtimes.get(result.recipient))
      } else if (result.status === 'unknown') {
        reporter.warn(`  "${result.recipient}" is not an agent — left in "${sender}" outbox to fix`)
      } else {
        // A FAILED carry (unreachable host, transient fs error) is retried on the next cycle:
        // forget the attempt so the unchanged draft classifies as dispatchable again. Attempt-once
        // still holds for a BOUNCE (`unknown`) — retrying a typo'd recipient can never succeed and
        // would warn forever. Un-delivered work stranded until morning is the worse failure.
        forgetOutboxAttempt(tracker, `${sender}/${result.recipient}`, mtimes.get(result.recipient))
        reporter.warn(
          `  failed "${sender}" → "${result.recipient}": ${result.error} (will retry next cycle)`,
        )
      }
    }
  }

  // Flush the wakes whose bundle window has elapsed. A single parcel keeps its specific courier;
  // several collapse to a count naming the senders (§7a). Entries still inside their window stay
  // pending for a later cycle — that wait is the whole point.
  const windowMs = getWakeBundleMs(config)
  const nudged = new Set<string>()
  for (const [recipient, entry] of [...pending]) {
    if (now - entry.queuedAt < windowMs) continue
    pending.delete(recipient)
    const courier =
      entry.descriptors.length === 1
        ? entry.descriptors[0]
        : `${entry.descriptors.length} new parcels from ${[...entry.senders].join(', ')}`
    await nudgeAgentSession({
      agent: entry.agent,
      displayName: recipient,
      courier,
      whenFocused: resolveAgentFocusPolicy(config, state, recipient),
      focusGraceSeconds: getFocusGraceSeconds(config),
      projectId: state.id,
      reporter,
    })
    nudged.add(recipient)
  }

  // Reported so the reminder sweep, which runs next in the same cycle, does not re-announce an
  // inbox to an agent this just woke — the two nudges landed a second apart otherwise.
  return nudged
}

export function classifyOutboxDraft(
  tracker: OutboxDispatchTracker,
  key: string,
  mtime: number,
): 'wait' | 'dispatch' {
  const signature = `${key}@${mtime}`
  const previous = tracker.seen.get(key)
  tracker.seen.set(key, mtime)
  if (tracker.done.has(signature)) return 'wait'
  if (previous === mtime) {
    tracker.done.add(signature)
    return 'dispatch'
  }
  return 'wait'
}

/**
 * Drop the record of a dispatch attempt so an unchanged draft is tried again next cycle. Used for a
 * failed carry: the attempt-once rule exists to stop a bad address looping, not to strand work
 * behind a transient error.
 */
export function forgetOutboxAttempt(
  tracker: OutboxDispatchTracker,
  key: string,
  mtime: number | undefined,
): void {
  if (mtime === undefined) return
  tracker.done.delete(`${key}@${mtime}`)
}

export function createOutboxDispatchTracker(): OutboxDispatchTracker {
  return { seen: new Map(), done: new Set() }
}

async function outboxDraftMtime(
  repoRoot: string,
  senderId: string,
  recipient: string,
): Promise<number | null> {
  try {
    return await maxMtime(getAgentHandoffOutQueuedRecipientDir(repoRoot, senderId, recipient))
  } catch {
    return null
  }
}

async function maxMtime(path: string): Promise<number> {
  const info = await stat(path)
  let newest = info.mtimeMs
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      const child = await maxMtime(join(path, entry))
      if (child > newest) newest = child
    }
  }
  return newest
}
