import type { QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'

import { assembleHandoff, assembleRemoteHandoff } from './assemble'
import { markHandoffSent, readOutboxDraft, readOutboxRecipients } from './outbox'
import { deliverHandoff, discardHandoff } from './parcel'

export interface DispatchOutboxResult {
  recipient: string
  status: 'delivered' | 'unknown' | 'failed'
  parcelName?: string
  hasNote?: boolean
  error?: string
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
    const recip = state.agents[recipient]
    if (!recip) {
      results.push({ recipient, status: 'unknown' })
      continue
    }
    try {
      const draft = await readOutboxDraft(repoRoot, senderId, recipient)
      const codeSourceName = draft.attach ?? sender
      const codeSource = state.agents[codeSourceName]
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
