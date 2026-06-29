import { rename, rm } from 'node:fs/promises'

import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import {
  getAgentDir,
  getAgentOutboxDir,
  getAgentRepoDir,
  remoteAgentDir,
  remoteAgentRepoDir,
  remoteProjectRoot,
  remoteQuimbyDir,
} from '@quimbyhq/paths'
import { renderAgentClaudeMd } from '@quimbyhq/template'
import type { Transport } from '@quimbyhq/transport'
import { getSSHTransport } from '@quimbyhq/transport'
import type { AgentLocation, SSHLocation } from '@quimbyhq/types'
import type { AgentState, QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { ensureDir, writeText } from '@quimbyhq/utils'
import { ensureWorkspace, loadState, saveState } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { join } from 'pathe'

export async function addAgent(
  repoRoot: string,
  name: string,
  opts?: {
    defaults?: { runtime?: string; entrypoint?: string }
    location?: AgentLocation
    syncRef?: string
    tmux?: boolean
  },
): Promise<AgentState> {
  validateAgentName(name)

  const state = await ensureWorkspace(repoRoot)

  if (state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" already exists`)
  }

  // Default the sync target to the branch the host is on right now; an explicit
  // --sync wins. This is recorded, not re-derived, so later host checkouts don't
  // silently retarget the agent.
  const syncRef = opts?.syncRef ?? (await getCurrentBranchOrRef(repoRoot))

  const agentState: AgentState = {
    id: crypto.randomUUID(),
    name,
    seedCommit: '',
    syncRef,
    createdAt: new Date().toISOString(),
    ...(opts?.defaults ? { defaults: opts.defaults } : {}),
    ...(opts?.location ? { location: opts.location } : {}),
    ...(opts?.tmux ? { tmux: true } : {}),
  }

  if (isSSH(opts?.location)) {
    // Remote agents are initialized lazily on first `quimby run`.
    // Record the current HEAD as the intended seed baseline.
    agentState.seedCommit = await git.getCurrentRef(repoRoot)
    state.agents[name] = agentState
    await saveState(repoRoot, state)
    return agentState
  }

  // Local agent: create dirs, clone, tag, write files.
  const agentDir = getAgentDir(repoRoot, name)
  const repoDir = getAgentRepoDir(repoRoot, name)

  await ensureDir(join(agentDir, 'inbox', 'status'))
  await ensureDir(getAgentOutboxDir(repoRoot, name))

  await git.clone(repoRoot, repoDir, { ref: state.sourceRef })
  await git.tag(repoDir, 'quimby/seed')
  await configureAgentIdentity(repoRoot, repoDir, name)

  agentState.seedCommit = await git.getCurrentRef(repoDir)

  await writeText(join(agentDir, 'assignment.md'), '')
  await writeText(join(agentDir, 'status.md'), 'idle')

  const claudeMd = renderAgentClaudeMd({ agentName: name })
  await writeText(join(agentDir, 'CLAUDE.md'), claudeMd)

  state.agents[name] = agentState
  await saveState(repoRoot, state)

  return agentState
}

export async function setAgentDefaults(
  repoRoot: string,
  name: string,
  updates: { runtime?: string; entrypoint?: string },
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  state.agents[name].defaults = { ...state.agents[name].defaults, ...updates }
  await saveState(repoRoot, state)
}

export async function setAgentGuard(repoRoot: string, name: string, guard: string): Promise<void> {
  const state = await loadState(repoRoot)
  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  // An empty string clears the guard; any non-empty value sets it.
  if (guard) {
    state.agents[name].guard = guard
  } else {
    delete state.agents[name].guard
  }
  await saveState(repoRoot, state)
}

export async function setAgentLocation(
  repoRoot: string,
  name: string,
  location: AgentLocation,
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  state.agents[name].location = location
  await saveState(repoRoot, state)
}

export async function setAgentSyncRef(
  repoRoot: string,
  name: string,
  syncRef: string,
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  state.agents[name].syncRef = syncRef
  await saveState(repoRoot, state)
}

export async function setAgentTmux(repoRoot: string, name: string, tmux: boolean): Promise<void> {
  const state = await loadState(repoRoot)
  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  if (tmux) {
    state.agents[name].tmux = true
  } else {
    delete state.agents[name].tmux
  }
  await saveState(repoRoot, state)
}

export async function removeAgent(repoRoot: string, name: string): Promise<void> {
  const state = await loadState(repoRoot)

  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }

  const agent = state.agents[name]

  if (isSSH(agent.location)) {
    const transport = getSSHTransport(agent.location)
    const rAgentDir = remoteAgentDir(state.id, name, agent.location.base)
    await transport.exec(`rm -rf ${rAgentDir}`)
  } else {
    const agentDir = getAgentDir(repoRoot, name)
    await rm(agentDir, { recursive: true, force: true })
  }

  delete state.agents[name]
  await saveState(repoRoot, state)
}

export async function renameAgent(
  repoRoot: string,
  oldName: string,
  newName: string,
): Promise<void> {
  validateAgentName(newName)

  const state = await loadState(repoRoot)

  if (!state.agents[oldName]) {
    throw new QuimbyError(`Agent "${oldName}" not found`)
  }

  if (state.agents[newName]) {
    throw new QuimbyError(`Agent "${newName}" already exists`)
  }

  const agent = state.agents[oldName]

  if (isSSH(agent.location)) {
    const transport = getSSHTransport(agent.location)
    const oldDir = remoteAgentDir(state.id, oldName, agent.location.base)
    const newDir = remoteAgentDir(state.id, newName, agent.location.base)
    await transport.exec(`mv ${oldDir} ${newDir}`)
  } else {
    const oldDir = getAgentDir(repoRoot, oldName)
    const newDir = getAgentDir(repoRoot, newName)
    await rename(oldDir, newDir)
  }

  agent.name = newName
  delete state.agents[oldName]
  state.agents[newName] = agent

  await saveState(repoRoot, state)
}

export async function resetAgent(repoRoot: string, name: string): Promise<void> {
  const state = await loadState(repoRoot)

  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }

  const agent = state.agents[name]

  if (isSSH(agent.location)) {
    const transport = getSSHTransport(agent.location)
    const rRoot = remoteProjectRoot(state.id, agent.location.base)
    const rQuimby = remoteQuimbyDir(state.id, agent.location.base)
    const rAgentDir = remoteAgentDir(state.id, name, agent.location.base)
    const rRepoDir = remoteAgentRepoDir(state.id, name, agent.location.base)

    await transport.syncProjectTo(repoRoot, rRoot)
    await transport.exec(`rm -rf ${rRepoDir}`)
    await transport.ensureDir(`${rAgentDir}/inbox/status`)
    await transport.ensureDir(`${rAgentDir}/outbox`)
    await transport.exec(`git clone ${rRoot} ${rRepoDir}`, { cwd: rQuimby })
    await transport.exec(`git tag quimby/seed`, { cwd: rRepoDir })
    await configureRemoteAgentIdentity(transport, rRepoDir, name)
    const seedCommit = (await transport.exec(`git rev-parse HEAD`, { cwd: rRepoDir })).trim()

    await transport.writeFile(`${rAgentDir}/assignment.md`, '')
    await transport.writeFile(`${rAgentDir}/status.md`, 'idle')

    state.agents[name].seedCommit = seedCommit
    await saveState(repoRoot, state)
    return
  }

  const agentDir = getAgentDir(repoRoot, name)
  const repoDir = getAgentRepoDir(repoRoot, name)

  await rm(repoDir, { recursive: true, force: true })

  const currentRef = await getCurrentBranchOrRef(repoRoot)
  await git.clone(repoRoot, repoDir, { ref: currentRef })
  await git.tag(repoDir, 'quimby/seed')
  await configureAgentIdentity(repoRoot, repoDir, name)

  const seedCommit = await git.getCurrentRef(repoDir)

  state.agents[name].seedCommit = seedCommit
  await saveState(repoRoot, state)

  await writeText(join(agentDir, 'assignment.md'), '')
  await writeText(join(agentDir, 'status.md'), 'idle')
}

export async function advanceAgent(
  repoRoot: string,
  name: string,
): Promise<{ newSeed: string; rebased: boolean; commitsReplayed: number }> {
  const state = await loadState(repoRoot)

  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }

  const agent = state.agents[name]

  if (isSSH(agent.location)) {
    return advanceSSHAgent(repoRoot, name, agent, state)
  }

  const repoDir = getAgentRepoDir(repoRoot, name)

  if (!(await git.isClean(repoDir))) {
    throw new QuimbyError(
      `Agent "${name}" has uncommitted changes — commit them first so they can be rebased onto the new baseline`,
    )
  }

  const hostHead = await resolveSyncTarget(repoRoot, agent, state.sourceRef)

  if (hostHead === agent.seedCommit) {
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  const logOutput = await git.log(repoDir, 'quimby/seed..HEAD', '%H')
  const agentCommits = logOutput.split('\n').filter(Boolean)
  const commitsReplayed = agentCommits.length

  await git.fetch(repoDir, 'origin')

  if (commitsReplayed === 0) {
    await git.resetHard(repoDir, hostHead)
    await git.tagForce(repoDir, 'quimby/seed')
    state.agents[name].seedCommit = hostHead
    await saveState(repoRoot, state)
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  try {
    await git.rebase(repoDir, hostHead)
  } catch {
    await git.rebaseAbort(repoDir)
    throw new QuimbyError(
      `Agent "${name}" has rebase conflicts onto ${hostHead.slice(0, 8)} — the rebase was aborted and the work is intact. ` +
        `Resolve them in the agent, or pack without --rebase and "quimby apply <pack> --3way". ` +
        `"quimby reset ${name} --force" starts fresh but discards the agent's work.`,
    )
  }

  // Tag the new base (hostHead), not the rebased HEAD
  await git.tagForce(repoDir, 'quimby/seed', hostHead)
  state.agents[name].seedCommit = hostHead
  await saveState(repoRoot, state)

  return { newSeed: hostHead, rebased: true, commitsReplayed }
}

async function advanceSSHAgent(
  repoRoot: string,
  name: string,
  agent: AgentState,
  state: QuimbyState,
): Promise<{ newSeed: string; rebased: boolean; commitsReplayed: number }> {
  const location = agent.location as SSHLocation
  const transport = getSSHTransport(location)
  const rRoot = remoteProjectRoot(state.id, location.base)
  const rRepoDir = remoteAgentRepoDir(state.id, name, location.base)

  await transport.syncProjectTo(repoRoot, rRoot)

  const hostHead = await resolveSyncTarget(repoRoot, agent, state.sourceRef)

  if (hostHead === agent.seedCommit) {
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  const statusOutput = await transport.exec(`git status --porcelain`, { cwd: rRepoDir })
  if (statusOutput.trim()) {
    throw new QuimbyError(
      `Agent "${name}" has uncommitted changes — commit them first so they can be rebased onto the new baseline`,
    )
  }

  const logOutput = await transport.exec(`git log quimby/seed..HEAD --format=%H`, {
    cwd: rRepoDir,
  })
  const agentCommits = logOutput.split('\n').filter(Boolean)
  const commitsReplayed = agentCommits.length

  await transport.exec(`git fetch origin`, { cwd: rRepoDir })

  if (commitsReplayed === 0) {
    await transport.exec(`git reset --hard ${hostHead}`, { cwd: rRepoDir })
    await transport.exec(`git tag -f quimby/seed`, { cwd: rRepoDir })
    state.agents[name].seedCommit = hostHead
    await saveState(repoRoot, state)
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  try {
    await transport.exec(`git rebase ${hostHead}`, { cwd: rRepoDir })
  } catch {
    await transport.exec(`git rebase --abort`, { cwd: rRepoDir }).catch(() => {})
    throw new QuimbyError(
      `Agent "${name}" has rebase conflicts onto ${hostHead.slice(0, 8)} — the rebase was aborted and the work is intact. ` +
        `Resolve them on the agent, or pack without --rebase and "quimby apply <pack> --3way". ` +
        `"quimby reset ${name} --force" starts fresh but discards the agent's work.`,
    )
  }

  await transport.exec(`git tag -f quimby/seed ${hostHead}`, { cwd: rRepoDir })
  state.agents[name].seedCommit = hostHead
  await saveState(repoRoot, state)

  return { newSeed: hostHead, rebased: true, commitsReplayed }
}

/**
 * Configure git identity in a local agent clone so the agent never has to set
 * git globals before its first commit. Inherits the host repo's identity when
 * present, else falls back to a quimby-scoped identity.
 */
async function configureAgentIdentity(
  repoRoot: string,
  repoDir: string,
  agentName: string,
): Promise<void> {
  const name = (await git.getConfig(repoRoot, 'user.name')) ?? `quimby-${agentName}`
  const email = (await git.getConfig(repoRoot, 'user.email')) ?? `quimby+${agentName}@local`
  await git.setConfig(repoDir, 'user.name', name)
  await git.setConfig(repoDir, 'user.email', email)
}

/**
 * Configure git identity in a remote agent clone. Inherits the remote machine's
 * global identity when present, else falls back to a quimby-scoped identity.
 * Agent names are validated to contain no shell metacharacters, so they are
 * safe to interpolate into the remote command.
 */
export async function configureRemoteAgentIdentity(
  transport: Transport,
  repoDir: string,
  agentName: string,
): Promise<void> {
  await transport.exec(
    `git config user.name "$(git config --global user.name 2>/dev/null || echo 'quimby-${agentName}')" && ` +
      `git config user.email "$(git config --global user.email 2>/dev/null || echo 'quimby+${agentName}@local')"`,
    { cwd: repoDir },
  )
}

function validateAgentName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new QuimbyError(
      `Invalid agent name "${name}". Use letters, numbers, hyphens, dots, and underscores.`,
    )
  }
  // `host` is the reserved sender of a host → agent handoff; it must not collide
  // with a real agent or a parcel from the host would be indistinguishable.
  if (name === 'host') {
    throw new QuimbyError('Agent name "host" is reserved (it names the host in a handoff).')
  }
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

async function getCurrentBranchOrRef(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
    const branch = stdout.trim()
    return branch === 'HEAD' ? await git.getCurrentRef(repoRoot) : branch
  } catch {
    return 'main'
  }
}
