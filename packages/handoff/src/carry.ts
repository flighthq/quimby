import { QuimbyError } from '@quimbyhq/errors'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import type { AgentAttestation, QuimbyState } from '@quimbyhq/types'

import { assembleHostHandoff, HOST_SENDER } from './assemble'
import { inboxNoticeText } from './notice'
import { deliverHandoff, discardHandoff } from './parcel'
import { stageParcel } from './stage'

export interface HandoffWorkOptions {
  state: Readonly<QuimbyState>
  repoRoot: string
  /** The source agent — or, when `to` is omitted, the recipient (host → it). */
  from: string
  to?: string
  message?: string
  userDirected?: boolean
  noteOnly?: boolean
  attach?: string
  /** Force the nudge on/off; when omitted the note's presence decides (data-only → no nudge). */
  nudge?: boolean
  beforeStage?: (codeSourceName: string) => Promise<void>
  /** Resolve the code source's attestation to embed in the carried parcel's `meta.yaml`. */
  resolveAttestation?: (codeSourceName: string) => Promise<AgentAttestation | null | undefined>
}

export interface HandoffWorkResult {
  /** The recorded sender: a source agent's name, or `host`. */
  from: string
  /** The recipient agent's name. */
  to: string
  parcelName: string
  /** Text to type into the recipient's session, or `null` when no nudge should fire. */
  nudgeText: string | null
  userDirected?: boolean
}

/**
 * Carry work directly to an agent's inbox: `handoffWork({from:'A', to:'B'})` is A → B;
 * `handoffWork({from:'B'})` (no `to`) is host → B, sender `host`. Assembles the parcel
 * (the source's diff and/or the note), delivers it to the recipient's inbox, then
 * discards the staging copy.
 *
 * A handoff is often pure data (a diff with no note), so by default the recipient is
 * woken only when a note is present — the instruction half. `nudge` forces either way.
 * The decision is returned as `nudgeText` (null = don't nudge) rather than enacted here,
 * so the live-session poke stays with the caller.
 */
export async function handoffWork(
  opts: Readonly<HandoffWorkOptions>,
  reporter: Reporter = silentReporter,
): Promise<HandoffWorkResult> {
  const { state, repoRoot } = opts

  const recipient = opts.to ?? opts.from
  const fromHost = opts.to === undefined

  const recip = Object.hasOwn(state.agents, recipient) ? state.agents[recipient] : undefined
  if (!recip) {
    throw new QuimbyError(`Agent "${recipient}" not found`)
  }

  const shouldNudge = opts.nudge ?? Boolean(opts.message)
  const requestedUserDirected = opts.userDirected ?? Boolean(opts.message)

  let parcelName: string
  let sender: string
  let userDirected: boolean | undefined
  if (fromHost) {
    const meta = await assembleHostHandoff({
      repoRoot,
      to: recipient,
      base: recip.seedCommit,
      note: opts.message,
      noteOnly: opts.noteOnly,
    })
    parcelName = meta.name
    sender = HOST_SENDER
    userDirected = meta.userDirected
  } else {
    if (!Object.hasOwn(state.agents, opts.from)) {
      throw new QuimbyError(`Agent "${opts.from}" not found`)
    }
    const meta = await stageParcel({
      state,
      repoRoot,
      from: opts.from,
      to: recipient,
      note: opts.message,
      userDirected: requestedUserDirected,
      attach: opts.attach,
      beforeStage: opts.beforeStage,
      resolveAttestation: opts.resolveAttestation,
    })
    parcelName = meta.name
    sender = opts.from
    userDirected = meta.userDirected
  }

  await deliverHandoff({
    repoRoot,
    name: parcelName,
    to: recipient,
    toId: recip.id,
    toLocation: recip.location,
    projectId: state.id,
  })
  await discardHandoff(repoRoot, parcelName)
  // Echo the note back so the caller can see `-m` was captured — the note lands in the
  // parcel, not the recipient's terse `quimby · parcel from …` nudge, so this is the one
  // place it surfaces to the host.
  const noteConfirmation = opts.message ? ` with your note ${quoteNote(opts.message)}` : ''
  reporter.success(
    `Handed off from ${fromHost ? HOST_SENDER : `"${sender}"`} to "${recipient}"${noteConfirmation}`,
  )

  return {
    from: sender,
    to: recipient,
    parcelName,
    nudgeText: shouldNudge ? inboxNoticeText(parcelName, opts.message) : null,
    userDirected,
  }
}

// The longest note echoed on the confirmation line before it is truncated; the full note
// always lives in the parcel, so this is a legibility cap, not a content limit.
const NOTE_ECHO_LIMIT = 72

// Render a note for the one-line handoff confirmation: whitespace collapsed to keep it on
// one line, and capped so a long note doesn't flood the log.
function quoteNote(note: string): string {
  const oneLine = note.replace(/\s+/g, ' ').trim()
  const capped =
    oneLine.length > NOTE_ECHO_LIMIT ? `${oneLine.slice(0, NOTE_ECHO_LIMIT - 1)}…` : oneLine
  return `"${capped}"`
}
