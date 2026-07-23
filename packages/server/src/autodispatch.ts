import { readdir, stat } from 'node:fs/promises'

import { getAgentAttestation } from '@quimbyhq/agent'
import { dispatchOutbox, pickupRemoteOutbox, readOutboxRecipients } from '@quimbyhq/handoff'
import { getAgentHandoffOutQueuedRecipientDir } from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { nudgeAgentSession } from '@quimbyhq/session'
import type { QuimbyState } from '@quimbyhq/types'
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
): Promise<void> {
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

    for (const recipient of recipients) {
      const key = `${sender}/${recipient}`
      present.add(key)
      const mtime = await outboxDraftMtime(repoRoot, senderId, recipient)
      if (mtime === null) continue
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
        const recip = state.agents[result.recipient]
        if (recip && result.parcelName) {
          await nudgeAgentSession({
            agent: recip,
            displayName: result.recipient,
            courier: `parcel ${result.parcelName} from ${sender}`,
            reporter,
          })
        }
      } else if (result.status === 'unknown') {
        reporter.warn(`  "${result.recipient}" is not an agent — left in "${sender}" outbox to fix`)
      } else {
        reporter.warn(`  failed "${sender}" → "${result.recipient}": ${result.error}`)
      }
    }
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
