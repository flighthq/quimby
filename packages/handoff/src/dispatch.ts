import { QuimbyError } from '@quimbyhq/errors'
import { getStagingHandoffDir } from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import type { AgentAttestation, NudgePolicy, QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { directsRecipient, honorsEscalation, normalizeNudgePolicy } from '@quimbyhq/workspace'

import { assembleHandoff, assembleRemoteHandoff } from './assemble'
import {
  clearRemoteOutboxDraft,
  copyOutboxExtraFiles,
  hasInboxParcel,
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
  /** Extra files the sender attached (via `agent.sh handoff --file`) that were carried along. */
  files?: string[]
  userDirected?: boolean
  /** A bounded upward summon honored along the inverse-directs edge (§6b). */
  escalation?: boolean
  /**
   * Whether this parcel should wake the recipient (§6a): a directed handoff, an honored escalation,
   * or a reply. Advisory parcels are passive (false), so the caller does not nudge for them.
   */
  interrupts?: boolean
  /**
   * Set when the sender ASKED for an interrupt the graph didn't grant, so the parcel was carried as
   * an ordinary advisory instead. Callers report this: a silent downgrade is indistinguishable from
   * "quimby is broken" — the parcel arrives, nobody wakes, and nothing says why.
   */
  downgraded?: 'escalation' | 'reply'
  /** The parcel name a refused `reply` named, so the operator can see *which* correlation failed. */
  replyTo?: string
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
    resolveAttestation?: (codeSourceName: string) => Promise<AgentAttestation | null | undefined>
    /** Workspace default when a recipient declares no `nudge` of its own. */
    defaultNudge?: NudgePolicy
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
      defaultNudge: opts.defaultNudge,
      state,
      repoRoot,
      sender,
      beforeStage: opts.beforeStage,
      resolveAttestation: opts.resolveAttestation,
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
  resolveAttestation?: (codeSourceName: string) => Promise<AgentAttestation | null | undefined>
  /** Workspace default when a recipient declares no `nudge` of its own (`directed` if omitted). */
  defaultNudge?: NudgePolicy
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

      // Classify the parcel's interrupt kind from sender intent + the directs graph (§6). The host
      // validates intent against authority: a declared `directs` edge (or an explicit delegate)
      // makes it directed; an `escalate` is honored only to the sender's escalation target, else
      // normalized to an ordinary advisory. A reply (`replyTo`) interrupts the asker by correlation.
      const userDirected = Boolean(draft.delegated) || directsRecipient(state, sender, recipient)
      const escalation = Boolean(draft.escalate) && honorsEscalation(state, sender, recipient)
      // A reply interrupts the asker only if it answers a parcel actually in the replier's inbox
      // (§6c) — else a stray `replyTo` is normalized to an ordinary advisory.
      const replyHonored = draft.replyTo
        ? await hasInboxParcel(repoRoot, senderState, state.id, draft.replyTo)
        : false
      // The recipient's own `nudge` policy decides how much reaches it: `all` wakes it for every
      // parcel (the unattended-fleet setting — nobody has to relay overnight), `never` for none,
      // and the default `directed` only for work the graph says is aimed at it (§6a).
      const policy = normalizeNudgePolicy(recip.nudge) ?? opts.defaultNudge ?? 'directed'
      const interrupts =
        policy === 'never' ? false : policy === 'all' || userDirected || escalation || replyHonored
      // The sender asked to interrupt and the graph said no — surfaced so the operator can see the
      // missing edge rather than an inexplicably quiet recipient.
      const downgraded: 'escalation' | 'reply' | undefined =
        draft.escalate && !escalation
          ? 'escalation'
          : draft.replyTo && !replyHonored
            ? 'reply'
            : undefined
      const tags = {
        userDirected,
        escalation,
        expectsReply: draft.expectsReply,
        replyTo: draft.replyTo,
      }

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
            ...tags,
            resolveAttestation: opts.resolveAttestation,
          })
        : await assembleHandoff({
            repoRoot,
            from: sender,
            codeSource: codeSourceName,
            codeSourceId: codeSource.id,
            to: recipient,
            note: draft.note || undefined,
            ...tags,
            resolveAttestation: opts.resolveAttestation,
          })

      // Carry any files the sender attached beyond the note + diff. They were staged into
      // the queued parcel by `agent.sh handoff --file`; without copying them into the
      // assembled staging parcel here they would be dropped and never reach the inbox.
      const files = await copyOutboxExtraFiles(
        repoRoot,
        senderId,
        recipient,
        getStagingHandoffDir(repoRoot, meta.name),
      )

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
        files: files.length > 0 ? files : undefined,
        userDirected: meta.userDirected,
        escalation: escalation || undefined,
        interrupts,
        downgraded,
        replyTo: draft.replyTo,
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
