import { rm } from 'node:fs/promises'

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
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentLocation, AgentState } from '@quimbyhq/types'
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

  // Local agent: create dirs, clone, tag, write files. Directories are keyed by the
  // agent's stable UUID so a later rename never moves them.
  const agentDir = getAgentDir(repoRoot, agentState.id)
  const repoDir = getAgentRepoDir(repoRoot, agentState.id)

  await ensureDir(join(agentDir, 'inbox', 'status'))
  await ensureDir(getAgentOutboxDir(repoRoot, agentState.id))

  await git.clone(repoRoot, repoDir, { ref: state.sourceRef })
  await git.tag(repoDir, 'quimby/seed')
  await configureAgentIdentity(repoRoot, repoDir, name)

  agentState.seedCommit = await git.getCurrentRef(repoDir)

  await writeText(join(agentDir, 'assignment.md'), '')
  await writeText(join(agentDir, 'status.md'), 'idle')

  const claudeMd = renderAgentClaudeMd({ agentName: name, agentId: agentState.id })
  await writeText(join(agentDir, 'CLAUDE.md'), claudeMd)

  state.agents[name] = agentState
  await saveState(repoRoot, state)

  return agentState
}

export async function rebuildAgent(repoRoot: string, name: string): Promise<void> {
  const state = await loadState(repoRoot)

  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }

  const agent = state.agents[name]

  if (isSSH(agent.location)) {
    const transport = getSSHTransport(agent.location)
    const rRoot = remoteProjectRoot(state.id, agent.location.base)
    const rQuimby = remoteQuimbyDir(state.id, agent.location.base)
    const rAgentDir = remoteAgentDir(state.id, agent.id, agent.location.base)
    const rRepoDir = remoteAgentRepoDir(state.id, agent.id, agent.location.base)

    await transport.syncProjectTo(repoRoot, rRoot)
    await transport.exec(`rm -rf ${rRepoDir} ${rAgentDir}/inbox ${rAgentDir}/outbox`)
    await transport.ensureDir(`${rAgentDir}/inbox/status`)
    await transport.ensureDir(`${rAgentDir}/outbox`)
    await transport.exec(`git clone ${rRoot} ${rRepoDir}`, { cwd: rQuimby })
    await transport.exec(`git tag quimby/seed`, { cwd: rRepoDir })
    await configureRemoteAgentIdentity(transport, rRepoDir, name, repoRoot)
    const seedCommit = (await transport.exec(`git rev-parse HEAD`, { cwd: rRepoDir })).trim()

    await transport.writeFile(`${rAgentDir}/assignment.md`, '')
    await transport.writeFile(`${rAgentDir}/status.md`, 'idle')

    state.agents[name].seedCommit = seedCommit
    await saveState(repoRoot, state)
    return
  }

  const agentDir = getAgentDir(repoRoot, agent.id)
  const repoDir = getAgentRepoDir(repoRoot, agent.id)

  await rm(repoDir, { recursive: true, force: true })

  const currentRef = await getCurrentBranchOrRef(repoRoot)
  await git.clone(repoRoot, repoDir, { ref: currentRef })
  await git.tag(repoDir, 'quimby/seed')
  await configureAgentIdentity(repoRoot, repoDir, name)

  const seedCommit = await git.getCurrentRef(repoDir)

  state.agents[name].seedCommit = seedCommit
  await saveState(repoRoot, state)

  // Clear the mailbox too — a rebuilt agent is a fresh start, so stale parcels and
  // a prior task shouldn't carry over.
  await rm(join(agentDir, 'inbox'), { recursive: true, force: true })
  await ensureDir(join(agentDir, 'inbox', 'status'))
  await rm(join(agentDir, 'outbox'), { recursive: true, force: true })
  await ensureDir(join(agentDir, 'outbox'))
  await writeText(join(agentDir, 'assignment.md'), '')
  await writeText(join(agentDir, 'status.md'), 'idle')
}

export async function removeAgent(repoRoot: string, name: string): Promise<void> {
  const state = await loadState(repoRoot)

  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }

  const agent = state.agents[name]

  if (isSSH(agent.location)) {
    const transport = getSSHTransport(agent.location)
    const rAgentDir = remoteAgentDir(state.id, agent.id, agent.location.base)
    await transport.exec(`rm -rf ${rAgentDir}`)
  } else {
    const agentDir = getAgentDir(repoRoot, agent.id)
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

  // Rename is a pure relabel: agent directories (local and remote), the sbx sandbox,
  // and the tmux session are all keyed by the stable UUID, so nothing on disk moves
  // and no running session or sandbox is orphaned. Only the display name changes.
  agent.name = newName
  delete state.agents[oldName]
  state.agents[newName] = agent

  await saveState(repoRoot, state)
}

/**
 * Configure git identity in a remote agent clone. Inherits the *host repo's*
 * identity (not the remote machine's), so an agent's commits — and the patches
 * `apply --commits` replays from them — carry the user's name, not a stray
 * worker-box default. Falls back to a quimby-scoped identity when the host has
 * none. Values are passed through `sq()` since a real name may contain spaces.
 */
export async function configureRemoteAgentIdentity(
  transport: Transport,
  repoDir: string,
  agentName: string,
  hostRepoRoot: string,
): Promise<void> {
  const { name, email } = await resolveAgentIdentity(hostRepoRoot, agentName)
  await transport.exec(`git config user.name ${sq(name)} && git config user.email ${sq(email)}`, {
    cwd: repoDir,
  })
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
  const { name, email } = await resolveAgentIdentity(repoRoot, agentName)
  await git.setConfig(repoDir, 'user.name', name)
  await git.setConfig(repoDir, 'user.email', email)
}

/**
 * Resolve the git identity an agent clone should commit under: the host repo's
 * identity when set, else a quimby-scoped fallback. Shared by local and remote
 * agents so both attribute work to the same author the user uses.
 */
async function resolveAgentIdentity(
  hostRepoRoot: string,
  agentName: string,
): Promise<{ name: string; email: string }> {
  return {
    name: (await git.getConfig(hostRepoRoot, 'user.name')) ?? `quimby-${agentName}`,
    email: (await git.getConfig(hostRepoRoot, 'user.email')) ?? `quimby+${agentName}@local`,
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

function validateAgentName(name: string): void {
  // Dots are excluded: tmux target syntax uses `.` as the pane separator
  // (`session:window.pane`), so a dot in a window name breaks `send-keys -t`.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    throw new QuimbyError(
      `Invalid agent name "${name}". Use letters, numbers, hyphens, and underscores (no dots).`,
    )
  }
  // `host` is the reserved sender of a host → agent handoff and the reserved
  // window name in the dashboard (`quimby run agent1 host`); it must not
  // collide with a real agent.
  if (name === 'host') {
    throw new QuimbyError('Agent name "host" is reserved (it names the host in a handoff).')
  }
}
