import { QuimbyError } from '@quimbyhq/errors'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'

import { assembleHandoff, assembleRemoteHandoff } from './assemble'
import {
  clearRemoteOutboxDraft,
  markHandoffSent,
  pickupRemoteOutbox,
  readOutboxDraft,
  readOutboxRecipients,
} from './outbox'
import { deliverHandoff, discardHandoff } from './parcel'

export interface DispatchOutboxResult {
  recipient: string
  status: 'delivered' | 'unknown' | 'failed'
  parcelName?: string
  hasNote?: boolean
  error?: string
}

export interface DispatchOutboxesResult {
  /** Per-sender outcomes, in the order senders were resolved. */
  senders: { sender: string; results: DispatchOutboxResult[] }[]
  /** Total parcels attempted across every sender (0 means every outbox was empty). */
  totalQueued: number
}

/**
 * Enact one or more agents' outboxes: resolve the sender set (one named agent, or every
 * agent with `all`), carry each sender's queued parcels via {@link dispatchOutbox}, and
 * return the per-sender results plus a total. Progress is narrated through `reporter`;
 * rendering each result and waking recipients stays with the caller (the CLI), which is
 * why nudging is not performed here.
 */
export async function dispatchOutboxes(
  opts: {
    state: Readonly<QuimbyState>
    repoRoot: string
    agent?: string
    all: boolean
    beforeStage?: (codeSourceName: string) => Promise<void>
  },
  reporter: Reporter = silentReporter,
): Promise<DispatchOutboxesResult> {
  const { state, repoRoot } = opts

  if (!opts.all && !opts.agent) {
    throw new QuimbyError('Specify an agent, or --all to dispatch every outbox.')
  }
  if (!opts.all && !Object.hasOwn(state.agents, opts.agent as string)) {
    throw new QuimbyError(`Agent "${opts.agent}" not found`)
  }

  const senderNames = opts.all ? Object.keys(state.agents) : [opts.agent as string]

  const senders: DispatchOutboxesResult['senders'] = []
  let totalQueued = 0
  for (const sender of senderNames) {
    // SSH agents author their outbox on the remote host; pick it up so the local
    // dispatch path (recipient listing, note reading) sees it. No-op for local agents.
    await pickupRemoteOutbox(repoRoot, state.agents[sender], state.id)
    const results = await dispatchOutbox({
      state,
      repoRoot,
      sender,
      beforeStage: opts.beforeStage,
    })
    if (results.length > 0) {
      reporter.start(`Dispatching "${sender}" → ${results.length} recipient(s)…`)
      senders.push({ sender, results })
      totalQueued += results.length
    }
  }

  return { senders, totalQueued }
}

export async function dispatchOutbox(opts: {
  state: Readonly<QuimbyState>
  repoRoot: string
  sender: string
  recipients?: readonly string[]
  beforeStage?: (codeSourceName: string) => Promise<void>
}): Promise<DispatchOutboxResult[]> {
  const { state, repoRoot, sender } = opts
  const senderState = state.agents[sender]
  if (!senderState) return []
  const senderId = senderState.id
  const recipients = opts.recipients ?? (await readOutboxRecipients(repoRoot, senderId))

  const results: DispatchOutboxResult[] = []
  for (const recipient of recipients) {
    const recip = Object.hasOwn(state.agents, recipient) ? state.agents[recipient] : undefined
    if (!recip) {
      results.push({ recipient, status: 'unknown' })
      continue
    }
    try {
      const draft = await readOutboxDraft(repoRoot, senderId, recipient)
      const codeSourceName = draft.attach ?? sender
      const codeSource = Object.hasOwn(state.agents, codeSourceName)
        ? state.agents[codeSourceName]
        : undefined
      if (!codeSource) {
        results.push({
          recipient,
          status: 'failed',
          error: `code source "${codeSourceName}" not found`,
        })
        continue
      }
      if (opts.beforeStage) await opts.beforeStage(codeSourceName)

      const meta = isSSH(codeSource.location)
        ? await assembleRemoteHandoff({
            repoRoot,
            from: sender,
            codeSource: codeSourceName,
            codeSourceId: codeSource.id,
            codeSourceLocation: codeSource.location,
            projectId: state.id,
            to: recipient,
            note: draft.note || undefined,
          })
        : await assembleHandoff({
            repoRoot,
            from: sender,
            codeSource: codeSourceName,
            codeSourceId: codeSource.id,
            to: recipient,
            note: draft.note || undefined,
          })

      await deliverHandoff({
        repoRoot,
        name: meta.name,
        to: recipient,
        toId: recip.id,
        toLocation: recip.location,
        projectId: state.id,
      })
      await discardHandoff(repoRoot, meta.name)
      await markHandoffSent(repoRoot, senderId, recipient)
      await clearRemoteOutboxDraft(senderState, state.id, recipient)
      results.push({
        recipient,
        status: 'delivered',
        parcelName: meta.name,
        hasNote: Boolean(draft.note),
      })
    } catch (err) {
      results.push({
        recipient,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return results
}
