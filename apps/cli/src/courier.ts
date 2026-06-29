import { syncAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { assembleHandoff, assembleRemoteHandoff } from '@quimbyhq/handoff'
import type { HandoffMeta, QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'

/**
 * Stage a parcel in the host loading dock from a code source's work and/or a note.
 *
 * Shared by `apply` (boundary) and `handoff` (peer delivery). The diff comes from the
 * `attach` agent if given, else `from`, and is the full working tree — committed,
 * uncommitted, and untracked — captured without ever making a commit in the source.
 * The caller consumes the staged parcel and is responsible for discarding it.
 */
export async function stageParcel(opts: {
  state: Readonly<QuimbyState>
  repoRoot: string
  from: string
  to?: string
  note?: string
  attach?: string
  message?: string
  rebase?: boolean
  name?: string
}): Promise<HandoffMeta> {
  const { state, repoRoot, from } = opts

  if (!state.agents[from]) {
    throw new QuimbyError(`Agent "${from}" not found`)
  }
  const codeSourceName = opts.attach ?? from
  const codeSource = state.agents[codeSourceName]
  if (!codeSource) {
    throw new QuimbyError(`Agent "${codeSourceName}" not found`)
  }

  if (isSSH(codeSource.location)) {
    if (opts.rebase) await rebaseOntoHead(repoRoot, codeSourceName)

    return assembleRemoteHandoff({
      repoRoot,
      from,
      codeSource: codeSourceName,
      codeSourceLocation: codeSource.location,
      projectId: state.id,
      to: opts.to,
      note: opts.note,
      suggestedMessage: opts.message,
      name: opts.name,
    })
  }

  if (opts.rebase) await rebaseOntoHead(repoRoot, codeSourceName)

  return assembleHandoff({
    repoRoot,
    from,
    codeSource: codeSourceName,
    to: opts.to,
    note: opts.note,
    suggestedMessage: opts.message,
    name: opts.name,
  })
}

async function rebaseOntoHead(repoRoot: string, agentName: string): Promise<void> {
  logger.start(`Syncing "${agentName}" onto its base`)
  const result = await syncAgent(repoRoot, agentName)
  if (result.rebased) {
    logger.success(`Rebased ${result.commitsReplayed} commit(s) onto ${result.newSeed.slice(0, 8)}`)
  } else {
    logger.info(`Already based on host HEAD (${result.newSeed.slice(0, 8)})`)
  }
}
