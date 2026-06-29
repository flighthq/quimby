import { advanceAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { assembleHandoff, assembleRemoteHandoff } from '@quimbyhq/handoff'
import { getAgentRepoDir, remoteAgentRepoDir } from '@quimbyhq/paths'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { HandoffMeta, QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { execa } from 'execa'

/**
 * Stage a parcel in the host loading dock from a code source's work and/or a note.
 *
 * Shared by `apply` (membrane) and `handoff` (peer delivery). The diff comes from the
 * `attach` agent if given, else `from`. `commitDirty` is for `apply`, which ships
 * everything across the membrane; `handoff` leaves it off and carries only committed
 * work, so a reviewer's incidental scratch never rides along with a note. The guard
 * runs only when the parcel actually carries code. The caller consumes the staged
 * parcel and is responsible for discarding it.
 */
export async function stageParcel(opts: {
  state: Readonly<QuimbyState>
  repoRoot: string
  from: string
  to?: string
  note?: string
  attach?: string
  message?: string
  commitDirty?: boolean
  skipGuard?: boolean
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
    const transport = getSSHTransport(codeSource.location)
    const rRepoDir = remoteAgentRepoDir(state.id, codeSourceName, codeSource.location.base)

    if (opts.commitDirty) {
      const dirty = (await transport.exec(`git status --porcelain`, { cwd: rRepoDir })).trim()
      if (dirty) {
        const message = opts.message ?? `Work by ${codeSourceName}`
        await transport.exec(`git add -A && git commit -m ${sq(message)}`, { cwd: rRepoDir })
        logger.info(`Committed working tree on "${codeSourceName}"`)
      }
    }

    if (opts.rebase) await rebaseOntoHead(repoRoot, codeSourceName)

    const hasCode =
      (await transport.exec(`git log quimby/seed..HEAD --format=%s`, { cwd: rRepoDir })).trim()
        .length > 0
    if (hasCode && codeSource.guard && !opts.skipGuard) {
      await runRemoteGuard(transport, rRepoDir, codeSourceName, codeSource.guard)
    }

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

  const repoDir = getAgentRepoDir(repoRoot, codeSourceName)

  if (opts.commitDirty && !(await git.isClean(repoDir))) {
    await git.addAll(repoDir)
    await git.commit(repoDir, opts.message ?? `Work by ${codeSourceName}`)
    logger.info(`Committed working tree on "${codeSourceName}"`)
  }

  if (opts.rebase) await rebaseOntoHead(repoRoot, codeSourceName)

  const hasCode =
    (await git.log(repoDir, 'quimby/seed..HEAD', '%s')).split('\n').filter(Boolean).length > 0
  if (hasCode && codeSource.guard && !opts.skipGuard) {
    logger.start(`Running guard on "${codeSourceName}": ${codeSource.guard}`)
    try {
      await execa(codeSource.guard, { cwd: repoDir, stdio: 'inherit', shell: true })
    } catch {
      throw new QuimbyError(
        `Guard failed for "${codeSourceName}" — fix it and retry (or pass --skip-guard)`,
      )
    }
    logger.success('Guard passed')
  }

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
  logger.start(`Rebasing "${agentName}" onto host HEAD`)
  const result = await advanceAgent(repoRoot, agentName)
  if (result.rebased) {
    logger.success(`Rebased ${result.commitsReplayed} commit(s) onto ${result.newSeed.slice(0, 8)}`)
  } else {
    logger.info(`Already based on host HEAD (${result.newSeed.slice(0, 8)})`)
  }
}

async function runRemoteGuard(
  transport: ReturnType<typeof getSSHTransport>,
  rRepoDir: string,
  agentName: string,
  guard: string,
): Promise<void> {
  logger.start(`Running guard on "${agentName}": ${guard}`)
  try {
    await transport.runInteractive('bash', ['-lc', sq(guard)], rRepoDir)
  } catch {
    throw new QuimbyError(
      `Guard failed for "${agentName}" — fix it and retry (or pass --skip-guard)`,
    )
  }
  logger.success('Guard passed')
}
