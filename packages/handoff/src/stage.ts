import { QuimbyError } from '@quimbyhq/errors'
import type { AgentAttestation, HandoffMeta, QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'

import { assembleHandoff, assembleRemoteHandoff } from './assemble'

export interface StageParcelOptions {
  state: Readonly<QuimbyState>
  repoRoot: string
  from: string
  to?: string
  note?: string
  userDirected?: boolean
  attach?: string
  message?: string
  name?: string
  /**
   * Ran against the resolved code-source name just before assembly — the seam through
   * which a caller injects a `--rebase` (sync onto base) without this package depending
   * on the agent lifecycle. Omit for no pre-stage step.
   */
  beforeStage?: (codeSourceName: string) => Promise<void>
  /** Resolve the code source's attestation to embed in `meta.yaml` (injected by the caller). */
  resolveAttestation?: (codeSourceName: string) => Promise<AgentAttestation | null | undefined>
}

/**
 * Stage a parcel in the host loading dock from a code source's work and/or a note.
 *
 * Shared by `handoffWork` and `mergeAgentWork`. The diff comes from the `attach` agent
 * if given, else `from`, and is the full working tree — committed, uncommitted, and
 * untracked — captured without ever making a commit in the source. The caller consumes
 * the staged parcel and is responsible for discarding it.
 */
export async function stageParcel(opts: Readonly<StageParcelOptions>): Promise<HandoffMeta> {
  const { state, repoRoot, from } = opts

  if (!Object.hasOwn(state.agents, from)) {
    throw new QuimbyError(`Agent "${from}" not found`)
  }
  const codeSourceName = opts.attach ?? from
  const codeSource = Object.hasOwn(state.agents, codeSourceName)
    ? state.agents[codeSourceName]
    : undefined
  if (!codeSource) {
    throw new QuimbyError(`Agent "${codeSourceName}" not found`)
  }

  if (opts.beforeStage) await opts.beforeStage(codeSourceName)

  if (isSSH(codeSource.location)) {
    return assembleRemoteHandoff({
      repoRoot,
      from,
      codeSource: codeSourceName,
      codeSourceId: codeSource.id,
      codeSourceLocation: codeSource.location,
      projectId: state.id,
      to: opts.to,
      note: opts.note,
      userDirected: opts.userDirected,
      suggestedMessage: opts.message,
      name: opts.name,
      resolveAttestation: opts.resolveAttestation,
    })
  }

  return assembleHandoff({
    repoRoot,
    from,
    codeSource: codeSourceName,
    codeSourceId: codeSource.id,
    to: opts.to,
    note: opts.note,
    userDirected: opts.userDirected,
    suggestedMessage: opts.message,
    name: opts.name,
    resolveAttestation: opts.resolveAttestation,
  })
}
