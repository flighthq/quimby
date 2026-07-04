import { rm } from 'node:fs/promises'

import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import {
  getAgentDir,
  getAgentRepoDir,
  remoteAgentDir,
  remoteAgentRepoDir,
  remoteProjectRoot,
} from '@quimbyhq/paths'
import { renderAgentAgentsMd, renderAgentClaudeMd } from '@quimbyhq/template'
import type { SSHTransport, Transport } from '@quimbyhq/transport'
import { getSSHTransport, sp, sq } from '@quimbyhq/transport'
import type { AgentDefaults, AgentLocation, AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { ensureDir, writeText } from '@quimbyhq/utils'
import {
  ensureWorkspace,
  loadState,
  removeAgentFromSubscriptions,
  renameAgentInSubscriptions,
  saveState,
} from '@quimbyhq/workspace'
import { execa } from 'execa'
import { join } from 'pathe'

export async function addAgent(
  repoRoot: string,
  name: string,
  opts?: {
    role?: string
    defaults?: AgentDefaults
    location?: AgentLocation
    syncRef?: string
    tmux?: boolean
    check?: string
    verifyByDefault?: boolean
  },
): Promise<AgentState> {
  validateAgentName(name)

  const state = await ensureWorkspace(repoRoot)

  if (Object.hasOwn(state.agents, name)) {
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
    ...(opts?.role ? { role: opts.role } : {}),
    ...(opts?.defaults ? { defaults: opts.defaults } : {}),
    ...(opts?.location ? { location: opts.location } : {}),
    ...(opts?.tmux ? { tmux: true } : {}),
    ...(opts?.check ? { check: opts.check } : {}),
    ...(opts?.verifyByDefault ? { verifyByDefault: true } : {}),
  }

  if (isSSH(opts?.location)) {
    // Remote agents are initialized lazily on first `quimby run`.
    // Record the current HEAD as the intended seed baseline.
    agentState.seedCommit = await git.getCurrentRef(repoRoot)
    state.agents[name] = agentState
    await saveState(repoRoot, state)
    return agentState
  }

  // Local agent: clone + seed the repo, then scaffold the agent dir. Directories are
  // keyed by the agent's stable UUID so a later rename never moves them.
  const agentDir = getAgentDir(repoRoot, agentState.id)
  const repoDir = getAgentRepoDir(repoRoot, agentState.id)

  agentState.seedCommit = await cloneAndSeedAgentRepo(repoRoot, repoDir, name, state.sourceRef)
  await writeAgentScaffold(agentDir, {
    agentName: name,
    agentId: agentState.id,
    withClaudeMd: true,
  })

  state.agents[name] = agentState
  await saveState(repoRoot, state)

  return agentState
}

export async function rebuildAgent(repoRoot: string, name: string): Promise<void> {
  const state = await loadState(repoRoot)

  if (!Object.hasOwn(state.agents, name)) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }

  const agent = state.agents[name]

  if (isSSH(agent.location)) {
    const transport = getSSHTransport(agent.location)
    const rRoot = remoteProjectRoot(state.id, agent.location.base)
    const rAgentDir = remoteAgentDir(state.id, agent.id, agent.location.base)
    const rRepoDir = remoteAgentRepoDir(state.id, agent.id, agent.location.base)

    await transport.syncProjectTo(repoRoot, rRoot)
    await transport.exec(
      `rm -rf ${sp(rRepoDir)} ${sp(`${rAgentDir}/handoff`)} ${sp(`${rAgentDir}/status`)}`,
    )
    state.agents[name].seedCommit = await cloneAndSeedRemoteAgentRepo(transport, {
      rRoot,
      rRepoDir,
      agentName: name,
      hostRepoRoot: repoRoot,
    })
    await writeRemoteAgentScaffold(transport, rAgentDir, {
      agentName: name,
      agentId: agent.id,
      withClaudeMd: false,
    })
    await saveState(repoRoot, state)
    return
  }

  const agentDir = getAgentDir(repoRoot, agent.id)
  const repoDir = getAgentRepoDir(repoRoot, agent.id)

  await rm(repoDir, { recursive: true, force: true })
  const currentRef = await getCurrentBranchOrRef(repoRoot)
  state.agents[name].seedCommit = await cloneAndSeedAgentRepo(repoRoot, repoDir, name, currentRef)
  await saveState(repoRoot, state)

  // A rebuilt agent is a fresh start — clear the mailbox so stale parcels and a prior
  // task don't carry over, then re-scaffold. CLAUDE.md is left in place.
  await rm(join(agentDir, 'handoff'), { recursive: true, force: true })
  await rm(join(agentDir, 'status'), { recursive: true, force: true })
  await writeAgentScaffold(agentDir, { agentName: name, agentId: agent.id, withClaudeMd: false })
}

export async function removeAgent(repoRoot: string, name: string): Promise<void> {
  const state = await loadState(repoRoot)

  if (!Object.hasOwn(state.agents, name)) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }

  const agent = state.agents[name]

  if (isSSH(agent.location)) {
    const transport = getSSHTransport(agent.location)
    const rAgentDir = remoteAgentDir(state.id, agent.id, agent.location.base)
    await transport.exec(`rm -rf ${sp(rAgentDir)}`)
  } else {
    const agentDir = getAgentDir(repoRoot, agent.id)
    await rm(agentDir, { recursive: true, force: true })
  }

  delete state.agents[name]
  // Scrub the removed name from the subscription map so the server never routes to a ghost
  // and `list` never prints a dead name.
  removeAgentFromSubscriptions(state, name)
  await saveState(repoRoot, state)
}

export async function renameAgent(
  repoRoot: string,
  oldName: string,
  newName: string,
): Promise<void> {
  validateAgentName(newName)

  const state = await loadState(repoRoot)

  if (!Object.hasOwn(state.agents, oldName)) {
    throw new QuimbyError(`Agent "${oldName}" not found`)
  }

  if (Object.hasOwn(state.agents, newName)) {
    throw new QuimbyError(`Agent "${newName}" already exists`)
  }

  const agent = state.agents[oldName]

  // Rename is a pure relabel: agent directories (local and remote), the sbx sandbox,
  // and the tmux session are all keyed by the stable UUID, so nothing on disk moves
  // and no running session or sandbox is orphaned. Only the display name changes.
  agent.name = newName
  delete state.agents[oldName]
  state.agents[newName] = agent

  // Subscriptions are keyed by display name, so the relabel has to follow the name through
  // both the subscriber keys and every target list.
  renameAgentInSubscriptions(state, oldName, newName)

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
 * Clone a remote agent's repo from the rsynced project root, tag `quimby/seed`, set its
 * git identity, and return the seed commit — the remote twin of the local clone+seed.
 * Shared by `rebuildAgent` (SSH) and the first-run init in `prepareSshLaunch`.
 */
export async function cloneAndSeedRemoteAgentRepo(
  transport: SSHTransport,
  opts: { rRoot: string; rRepoDir: string; agentName: string; hostRepoRoot: string },
): Promise<string> {
  await transport.exec(`git clone ${sp(opts.rRoot)} ${sp(opts.rRepoDir)}`)
  await transport.exec(`git tag quimby/seed`, { cwd: opts.rRepoDir })
  await configureRemoteAgentIdentity(transport, opts.rRepoDir, opts.agentName, opts.hostRepoRoot)
  return (await transport.exec(`git rev-parse HEAD`, { cwd: opts.rRepoDir })).trim()
}

/**
 * Create a remote agent's mailbox dirs and baseline files (assignment/status, optionally
 * AGENTS.md/CLAUDE.md) over transport — the remote twin of {@link writeAgentScaffold}. Shared by
 * `rebuildAgent` (SSH) and the first-run init in `prepareSshLaunch`.
 */
export async function writeRemoteAgentScaffold(
  transport: SSHTransport,
  rAgentDir: string,
  opts: { agentName: string; agentId: string; withClaudeMd: boolean },
): Promise<void> {
  await transport.ensureDir(`${rAgentDir}/handoff/out/draft`)
  await transport.ensureDir(`${rAgentDir}/handoff/out/queued`)
  await transport.ensureDir(`${rAgentDir}/handoff/in/received`)
  await transport.ensureDir(`${rAgentDir}/status`)
  await transport.writeFile(`${rAgentDir}/assignment.md`, '')
  await transport.writeFile(`${rAgentDir}/status.md`, 'idle')
  if (opts.withClaudeMd) {
    const claudeMd = renderAgentClaudeMd({ agentName: opts.agentName, agentId: opts.agentId })
    await transport.writeFile(`${rAgentDir}/AGENTS.md`, renderAgentAgentsMd())
    await transport.writeFile(`${rAgentDir}/CLAUDE.md`, claudeMd)
  }
}

/**
 * A guarded shell one-liner that migrates a *remote* agent's legacy `inbox/`+`outbox/` mailbox
 * into the explicit-lifecycle `handoff/` tree (the SSH twin of `migrateAgentMailbox`). Runs only
 * when a legacy dir exists and `handoff/` does not, so it is idempotent and a no-op for a
 * freshly-scaffolded remote agent. Reused by `prepareSshLaunch` and the dashboard's SSH window so
 * the reshape happens on the next `run` wherever the agent is launched. Uses `sh` glob semantics:
 * `*` skips dotfiles, so `.sent`/`.done` are excluded from the plain loops and handled explicitly.
 */
export function renderRemoteMailboxMigration(rAgentDir: string): string {
  const a = sp(rAgentDir)
  return (
    `if { [ -d ${a}/inbox ] || [ -d ${a}/outbox ]; } && [ ! -d ${a}/handoff ]; then ` +
    `mkdir -p ${a}/handoff/out/queued ${a}/handoff/out/sent ${a}/handoff/in/received ${a}/handoff/in/processed ${a}/status; ` +
    `if [ -d ${a}/outbox ]; then ` +
    `if [ -d ${a}/outbox/.sent ]; then for d in ${a}/outbox/.sent/*/; do [ -d "$d" ] && mv "$d" ${a}/handoff/out/sent/; done; fi; ` +
    `for d in ${a}/outbox/*/; do [ -d "$d" ] && mv "$d" ${a}/handoff/out/queued/; done; ` +
    `rm -rf ${a}/outbox; fi; ` +
    `if [ -d ${a}/inbox ]; then ` +
    `if [ -d ${a}/inbox/status ]; then for f in ${a}/inbox/status/* ${a}/inbox/status/.[!.]*; do [ -e "$f" ] && mv "$f" ${a}/status/; done; rm -rf ${a}/inbox/status; fi; ` +
    `if [ -d ${a}/inbox/.done ]; then for d in ${a}/inbox/.done/*/; do [ -d "$d" ] && mv "$d" ${a}/handoff/in/processed/; done; rm -rf ${a}/inbox/.done; fi; ` +
    `for d in ${a}/inbox/*/; do [ -d "$d" ] && mv "$d" ${a}/handoff/in/received/; done; ` +
    `rm -rf ${a}/inbox; fi; ` +
    `fi`
  )
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

/** Clone the host repo into a local agent dir, tag the seed, set identity; return the seed. */
async function cloneAndSeedAgentRepo(
  repoRoot: string,
  repoDir: string,
  agentName: string,
  ref: string,
): Promise<string> {
  await git.clone(repoRoot, repoDir, { ref })
  await git.tag(repoDir, 'quimby/seed')
  await configureAgentIdentity(repoRoot, repoDir, agentName)
  return git.getCurrentRef(repoDir)
}

/** Create a local agent's mailbox tree and baseline files (assignment/status, optional instructions). */
async function writeAgentScaffold(
  agentDir: string,
  opts: { agentName: string; agentId: string; withClaudeMd: boolean },
): Promise<void> {
  // The explicit-lifecycle tree: agents author under out/draft and publish into out/queued;
  // parcels arrive in in/received; status mirrors sit at their own `status/` root.
  await ensureDir(join(agentDir, 'handoff', 'out', 'draft'))
  await ensureDir(join(agentDir, 'handoff', 'out', 'queued'))
  await ensureDir(join(agentDir, 'handoff', 'in', 'received'))
  await ensureDir(join(agentDir, 'status'))
  await writeText(join(agentDir, 'assignment.md'), '')
  await writeText(join(agentDir, 'status.md'), 'idle')
  if (opts.withClaudeMd) {
    const claudeMd = renderAgentClaudeMd({ agentName: opts.agentName, agentId: opts.agentId })
    await writeText(join(agentDir, 'AGENTS.md'), renderAgentAgentsMd())
    await writeText(join(agentDir, 'CLAUDE.md'), claudeMd)
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
  // The whitelist keeps names free of characters that carry meaning elsewhere: `.` is tmux's
  // pane separator (`session:window.pane`, so a dot breaks `send-keys -t`), and `:` is the
  // dashboard layout weight sigil (`agent:70`), which stays unambiguous only if a name can
  // never contain one.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    throw new QuimbyError(
      `Invalid agent name "${name}". Use letters, numbers, hyphens, and underscores (no dots or colons).`,
    )
  }
  // `host` is the reserved sender of a host → agent handoff and the reserved
  // window name in the dashboard (`quimby run agent1 host`); it must not
  // collide with a real agent.
  if (name === 'host') {
    throw new QuimbyError('Agent name "host" is reserved (it names the host in a handoff).')
  }
}
