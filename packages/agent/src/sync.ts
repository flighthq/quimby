import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getAgentRepoDir, remoteAgentRepoDir, remoteProjectRoot } from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import type { AgentState, QuimbyState, SSHLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { loadState, saveState } from '@quimbyhq/workspace'

export async function getAgentPendingWork(
  repoRoot: string,
  stateId: string,
  agent: Readonly<AgentState>,
): Promise<{ commits: number; dirty: boolean } | null> {
  try {
    if (isSSH(agent.location)) {
      const transport = getSSHTransport(agent.location)
      const rRepoDir = remoteAgentRepoDir(stateId, agent.id, agent.location.base)
      const [countOut, statusOut] = await Promise.all([
        transport.exec(`git rev-list --count quimby/seed..HEAD`, { cwd: rRepoDir }),
        transport.exec(`git status --porcelain`, { cwd: rRepoDir }),
      ])
      return {
        commits: parseInt(countOut.trim(), 10) || 0,
        dirty: statusOut.trim().length > 0,
      }
    }

    const repoDir = getAgentRepoDir(repoRoot, agent.id)
    const [commits, clean] = await Promise.all([
      git.countCommits(repoDir, 'quimby/seed..HEAD'),
      git.isClean(repoDir),
    ])
    return { commits, dirty: !clean }
  } catch {
    return null
  }
}

export async function getAgentSyncStatus(
  repoRoot: string,
  agent: Readonly<AgentState>,
  fallback: string,
): Promise<{ behind: number; syncRef: string; targetCommit: string }> {
  const syncRef = agent.syncRef ?? fallback
  const targetCommit = await resolveSyncTarget(repoRoot, agent, fallback)
  if (!agent.seedCommit || agent.seedCommit === targetCommit) {
    return { behind: 0, syncRef, targetCommit }
  }
  const behind = await git.countCommits(repoRoot, `${agent.seedCommit}..${targetCommit}`)
  return { behind, syncRef, targetCommit }
}

export async function syncAgent(
  repoRoot: string,
  name: string,
  opts?: { force?: boolean; base?: string },
): Promise<{ newSeed: string; rebased: boolean; commitsReplayed: number }> {
  const state = await loadState(repoRoot)

  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }

  // --base retargets the agent's recorded sync ref (persisted), then syncs onto it.
  if (opts?.base) {
    state.agents[name].syncRef = opts.base
    await saveState(repoRoot, state)
  }

  const agent = state.agents[name]

  if (isSSH(agent.location)) {
    return syncSSHAgent(repoRoot, name, agent, state, opts)
  }

  const repoDir = getAgentRepoDir(repoRoot, agent.id)
  const hostHead = await resolveSyncTarget(repoRoot, agent, state.sourceRef)
  await git.fetch(repoDir, 'origin')

  // Hard: snap the agent's repo to the base, discarding its commits and working
  // changes. The agent (mailbox/assignment) is left alone — only the code resets.
  if (opts?.force) {
    await git.resetHard(repoDir, hostHead)
    await git.tagForce(repoDir, 'quimby/seed', hostHead)
    state.agents[name].seedCommit = hostHead
    await saveState(repoRoot, state)
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  if (hostHead === agent.seedCommit) {
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  const commitsReplayed = (await git.log(repoDir, 'quimby/seed..HEAD', '%H'))
    .split('\n')
    .filter(Boolean).length

  // Auto-stash uncommitted + untracked work so a dirty tree never blocks the sync.
  const stashed = !(await git.isClean(repoDir)) ? await git.stash(repoDir) : false

  if (commitsReplayed === 0) {
    await git.resetHard(repoDir, hostHead)
  } else {
    try {
      await git.rebase(repoDir, hostHead)
    } catch {
      await git.rebaseAbort(repoDir)
      if (stashed) await git.stashPop(repoDir).catch(() => {})
      throw new QuimbyError(
        `Agent "${name}" has rebase conflicts onto ${hostHead.slice(0, 8)} — aborted, work intact. ` +
          `Resolve them on the agent, or "quimby sync ${name} -f" to force to the base (discards the agent's commits).`,
      )
    }
  }

  await git.tagForce(repoDir, 'quimby/seed', hostHead)
  if (stashed) {
    try {
      await git.stashPop(repoDir)
    } catch {
      throw new QuimbyError(
        `Agent "${name}" synced onto ${hostHead.slice(0, 8)}, but restoring its uncommitted work hit conflicts — resolve them on the agent.`,
      )
    }
  }
  state.agents[name].seedCommit = hostHead
  await saveState(repoRoot, state)

  return { newSeed: hostHead, rebased: commitsReplayed > 0, commitsReplayed }
}

async function syncSSHAgent(
  repoRoot: string,
  name: string,
  agent: AgentState,
  state: QuimbyState,
  opts?: { force?: boolean; base?: string },
): Promise<{ newSeed: string; rebased: boolean; commitsReplayed: number }> {
  const location = agent.location as SSHLocation
  const transport = getSSHTransport(location)
  const rRoot = remoteProjectRoot(state.id, location.base)
  const rRepoDir = remoteAgentRepoDir(state.id, agent.id, location.base)

  await transport.syncProjectTo(repoRoot, rRoot)

  const hostHead = await resolveSyncTarget(repoRoot, agent, state.sourceRef)
  await transport.exec(`git fetch origin`, { cwd: rRepoDir })

  if (opts?.force) {
    await transport.exec(`git reset --hard ${hostHead}`, { cwd: rRepoDir })
    await transport.exec(`git tag -f quimby/seed ${hostHead}`, { cwd: rRepoDir })
    state.agents[name].seedCommit = hostHead
    await saveState(repoRoot, state)
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  if (hostHead === agent.seedCommit) {
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  const commitsReplayed = (
    await transport.exec(`git log quimby/seed..HEAD --format=%H`, {
      cwd: rRepoDir,
    })
  )
    .split('\n')
    .filter(Boolean).length

  const dirty =
    (await transport.exec(`git status --porcelain`, { cwd: rRepoDir })).trim().length > 0
  if (dirty) {
    await transport.exec(`git stash push --include-untracked -m quimby-sync`, { cwd: rRepoDir })
  }

  if (commitsReplayed === 0) {
    await transport.exec(`git reset --hard ${hostHead}`, { cwd: rRepoDir })
  } else {
    try {
      await transport.exec(`git rebase ${hostHead}`, { cwd: rRepoDir })
    } catch {
      await transport.exec(`git rebase --abort`, { cwd: rRepoDir }).catch(() => {})
      if (dirty) await transport.exec(`git stash pop`, { cwd: rRepoDir }).catch(() => {})
      throw new QuimbyError(
        `Agent "${name}" has rebase conflicts onto ${hostHead.slice(0, 8)} — aborted, work intact. ` +
          `Resolve them on the agent, or "quimby sync ${name} -f" to force to the base (discards the agent's commits).`,
      )
    }
  }

  await transport.exec(`git tag -f quimby/seed ${hostHead}`, { cwd: rRepoDir })
  if (dirty) {
    try {
      await transport.exec(`git stash pop`, { cwd: rRepoDir })
    } catch {
      throw new QuimbyError(
        `Agent "${name}" synced onto ${hostHead.slice(0, 8)}, but restoring its uncommitted work hit conflicts — resolve them on the agent.`,
      )
    }
  }
  state.agents[name].seedCommit = hostHead
  await saveState(repoRoot, state)

  return { newSeed: hostHead, rebased: commitsReplayed > 0, commitsReplayed }
}

/**
 * Resolve the commit an agent should advance onto: the tip of its recorded
 * `syncRef` (falling back to the workspace `sourceRef` for agents created
 * before sync targets existed). Resolution happens in the host repo, so the
 * result is deterministic regardless of what the host is checked out to.
 */
async function resolveSyncTarget(
  repoRoot: string,
  agent: AgentState,
  fallback: string,
): Promise<string> {
  const ref = agent.syncRef ?? fallback
  try {
    return await git.revParse(repoRoot, ref)
  } catch {
    throw new QuimbyError(
      `Agent "${agent.name}" syncs against "${ref}", which doesn't resolve in the host repo. ` +
        `Retarget it with "quimby set ${agent.name} --sync <ref>".`,
    )
  }
}
