import { syncAgent } from '@quimbyhq/agent'
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
 * Shared by `apply` (boundary) and `handoff` (peer delivery). The diff comes from the
 * `attach` agent if given, else `from`, and is the full working tree — committed,
 * uncommitted, and untracked — captured without ever making a commit in the source.
 * The guard runs when there is any work to ship. The caller consumes the staged parcel
 * and is responsible for discarding it.
 */
export async function stageParcel(opts: {
  state: Readonly<QuimbyState>
  repoRoot: string
  from: string
  to?: string
  note?: string
  attach?: string
  message?: string
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

    if (opts.rebase) await rebaseOntoHead(repoRoot, codeSourceName)

    const dirty =
      (await transport.exec(`git status --porcelain`, { cwd: rRepoDir })).trim().length > 0
    const committed =
      (await transport.exec(`git log quimby/seed..HEAD --format=%s`, { cwd: rRepoDir })).trim()
        .length > 0
    if ((dirty || committed) && codeSource.guard && !opts.skipGuard) {
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

  if (opts.rebase) await rebaseOntoHead(repoRoot, codeSourceName)

  const hasWork =
    !(await git.isClean(repoDir)) ||
    (await git.log(repoDir, 'quimby/seed..HEAD', '%s')).split('\n').filter(Boolean).length > 0
  if (hasWork && codeSource.guard && !opts.skipGuard) {
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
  logger.start(`Syncing "${agentName}" onto its base`)
  const result = await syncAgent(repoRoot, agentName)
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
    // Interactive login shell (`-i`): version managers like nvm put `npm`/`node`
    // on PATH from `~/.bashrc`, which a non-interactive `-lc` shell skips — so a
    // guard like `npm run ci` would fail with "npm: command not found". `ssh -t`
    // gives us a PTY, so an interactive shell runs cleanly here.
    await transport.runInteractive('bash', ['-lic', sq(guard)], rRepoDir)
  } catch {
    throw new QuimbyError(
      `Guard failed for "${agentName}" — fix it and retry (or pass --skip-guard)`,
    )
  }
  logger.success('Guard passed')
}
