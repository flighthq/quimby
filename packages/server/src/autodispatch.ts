import { readdir, stat } from 'node:fs/promises'

import { dispatchOutbox, pickupRemoteOutbox, readOutboxRecipients } from '@quimbyhq/handoff'
import { getAgentOutboxDraftDir } from '@quimbyhq/paths'
import { nudgeAgentSession } from '@quimbyhq/session'
import type { QuimbyState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { join } from 'pathe'

export interface OutboxDispatchTracker {
  seen: Map<string, number>
  done: Set<string>
}

export async function autoDispatchOutboxes(
  repoRoot: string,
  state: Readonly<QuimbyState>,
  tracker: OutboxDispatchTracker,
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

    logger.info(`[auto-dispatch] "${sender}" → ${stable.join(', ')}`)
    const results = await dispatchOutbox({ state, repoRoot, sender, recipients: stable })
    for (const result of results) {
      if (result.status === 'delivered') {
        logger.success(`  delivered "${sender}" → "${result.recipient}" (${result.parcelName})`)
        const recip = state.agents[result.recipient]
        if (recip) {
          await nudgeAgentSession({
            agent: recip,
            displayName: result.recipient,
            text: `New handoff in your inbox: @inbox/${result.parcelName}/ — please review.`,
          })
        }
      } else if (result.status === 'unknown') {
        logger.warn(`  "${result.recipient}" is not an agent — left in "${sender}" outbox to fix`)
      } else {
        logger.warn(`  failed "${sender}" → "${result.recipient}": ${result.error}`)
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
    return await maxMtime(getAgentOutboxDraftDir(repoRoot, senderId, recipient))
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
