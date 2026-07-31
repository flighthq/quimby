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
import { getFocusGraceSeconds, resolveAgentFocusPolicy } from '@quimbyhq/workspace'
import { join } from 'pathe'

export interface OutboxDispatchTracker {
  seen: Map<string, number>
  done: Set<string>
}

export async function autoDispatchOutboxes(
  repoRoot: string,
  state: Readonly<QuimbyState>,
  tracker: OutboxDispatchTracker,
  reporter: Reporter = silentReporter,
  defaultNudge: NudgePolicy = 'directed',
  config: Readonly<QuimbyConfig> = {},
): Promise<void> {
  // §7a: coalesce this cycle's interrupting deliveries into ONE nudge per recipient — N parcels
  // arriving in a poll window wake the recipient once (fewer tokens, fewer injections) rather than
  // N times. Delivery stays per-parcel and immediate; only the wake is batched.
  const pending = new Map<
    string,
    { agent: AgentState; descriptors: string[]; senders: Set<string> }
  >()
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

  // Flush the coalesced wakes: one nudge per recipient for the whole cycle. A single parcel keeps
  // its specific courier; several collapse to a count naming the senders (§7a).
  for (const [recipient, entry] of pending) {
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
  }
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
