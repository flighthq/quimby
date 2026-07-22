import { chmod, readdir, rm } from 'node:fs/promises'

import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import {
  getAgentDir,
  getAgentRepoDir,
  remoteAgentDir,
  remoteAgentRepoDir,
  remoteProjectRoot,
} from '@quimbyhq/paths'
import {
  AGENT_SCRIPT_CMD_FILENAME,
  AGENT_SCRIPT_LEGACY_CMD_FILENAME,
  AGENT_SCRIPT_LEGACY_SH_FILENAME,
  AGENT_SCRIPT_SH_FILENAME,
  renderAgentAgentsMd,
  renderAgentClaudeMd,
  renderAgentScript,
  renderAgentScriptCmd,
} from '@quimbyhq/template'
import type { SSHTransport, Transport } from '@quimbyhq/transport'
import { getSSHTransport, sp, sq } from '@quimbyhq/transport'
import type { AgentDefaults, AgentLocation, AgentState, QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { ensureDir, writeText } from '@quimbyhq/utils'
import { ensureWorkspace, loadState, saveState } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { join } from 'pathe'

export async function addAgent(
  repoRoot: string,
  explicitName: string | undefined,
  opts?: {
    role?: string
    runtimeProfile?: string
    defaults?: AgentDefaults
    location?: AgentLocation
    syncRef?: string
    tmux?: boolean
    check?: string
    verifyByDefault?: boolean
  },
): Promise<AgentState> {
  const state = await ensureWorkspace(repoRoot)

  // A bare name is taken verbatim; omitting it auto-labels the next free `<role>` /
  // `<role>-N` slot, so a same-role +1 needs no invented name (the friendly name is a
  // pure display label — identity is the UUID below).
  const name = explicitName ?? autoAgentName(state, opts?.role)
  validateAgentName(name)

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
    ...(opts?.runtimeProfile ? { runtimeProfile: opts.runtimeProfile } : {}),
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
    runtime: agentState.defaults?.runtime,
  })

  state.agents[name] = agentState
  await saveState(repoRoot, state)

  return agentState
}

/**
 * The next free agent label for a `<base>` slot: `base` itself when unused, else the lowest
 * `base-N` (N ≥ 2) not already taken. Lets a same-role +1 be minted without inventing a name —
 * the label is display-only, so `builder`, `builder-2`, `builder-3` all tab into one role slot.
 */
export function generateAgentName(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
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
    // Empty the mailbox in place — remove parcels within each tray but keep the tray directories
    // (handoff/in, handoff/out, …) as the same inodes, the remote twin of `clearMailboxContents`.
    // A remote agent can also run over a virtiofs/9p guest mount, where `rm -rf handoff` + recreate
    // swaps the inodes and leaves the guest with a stale dentry that breaks its next handoff.
    const rTrays = MAILBOX_TRAYS.map((t) => sp(`${rAgentDir}/${t}`)).join(' ')
    await transport.exec(
      `rm -rf ${sp(rRepoDir)}; for d in ${rTrays}; do [ -d "$d" ] && rm -rf "$d"/* "$d"/.[!.]* 2>/dev/null; done; true`,
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
      runtime: agent.defaults?.runtime,
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

  // A rebuilt agent is a fresh start — empty the mailbox so stale parcels and a prior task don't
  // carry over, then re-scaffold. The clear is done IN PLACE (contents removed, tray directories
  // kept), never `rm -rf handoff`: under a virtiofs/9p guest mount, swapping the handoff/{in,out}
  // inodes out from under the guest leaves it holding a stale dentry — the dir still lists but
  // stat's ENOENT until the guest cache is dropped (root-only), which breaks the agent's next
  // handoff. Keeping the inodes stable avoids that window. Re-scaffolding then refreshes the
  // quimby-generated instruction files (overwritten on every launch anyway).
  await clearMailboxContents(agentDir)
  await writeAgentScaffold(agentDir, {
    agentName: name,
    agentId: agent.id,
    runtime: agent.defaults?.runtime,
  })
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
  // Clone from the rsynced local tree (`rRoot`), never from the project's real `origin`. The
  // source bytes reach the remote over the SSH wire via rsync (`syncProjectTo`), so the remote
  // never fetches from GitHub and needs no credentials for a private repo. `git clone <path>`
  // sets the agent repo's `origin` to `rRoot` (a local path on the remote), not the GitHub URL,
  // so later `fetch`/`pull` inside the agent also stay local and credential-free.
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
  opts: { agentName: string; agentId: string; runtime?: string },
): Promise<void> {
  await transport.ensureDir(`${rAgentDir}/handoff/out/draft`)
  await transport.ensureDir(`${rAgentDir}/handoff/out/queued`)
  await transport.ensureDir(`${rAgentDir}/handoff/in/received`)
  await transport.ensureDir(`${rAgentDir}/status`)
  await transport.writeFile(`${rAgentDir}/assignment.md`, '')
  await transport.writeFile(`${rAgentDir}/status.md`, 'idle')
  await writeRemoteAgentInstructions(transport, rAgentDir, opts)
}

/**
 * Write a remote agent's Quimby-tier instruction files — `CLAUDE.md` (Claude Code) and `AGENTS.md`
 * (Codex et al.), both carrying the shared context. Quimby-owned and regenerated, so it is called
 * both at scaffold time and on every launch (the remote twin of {@link writeAgentInstructions}) so
 * newer instructions reach an existing remote agent without a rebuild.
 */
export async function writeRemoteAgentInstructions(
  transport: SSHTransport,
  rAgentDir: string,
  opts: { agentName: string; agentId: string; runtime?: string },
): Promise<void> {
  await transport.writeFile(`${rAgentDir}/CLAUDE.md`, renderAgentClaudeMd(opts))
  await transport.writeFile(`${rAgentDir}/AGENTS.md`, renderAgentAgentsMd(opts))
  // The agent-side mailbox tool (see the local twin). The remote floor is POSIX, so the .sh is
  // what actually runs there; the .cmd is written too for parity. chmod +x so it runs directly.
  // Regenerated on every launch, so renames of this tool reach an existing agent with no rebuild —
  // which is why the old quimby-agent.* names are removed here rather than shimmed, keeping the
  // agent dir showing exactly the current tool.
  const shPath = `${rAgentDir}/${AGENT_SCRIPT_SH_FILENAME}`
  await transport.writeFile(shPath, renderAgentScript())
  await transport.exec(`chmod +x ${sp(shPath)}`)
  await transport.writeFile(`${rAgentDir}/${AGENT_SCRIPT_CMD_FILENAME}`, renderAgentScriptCmd())
  await transport.exec(
    `rm -f ${sp(`${rAgentDir}/${AGENT_SCRIPT_LEGACY_SH_FILENAME}`)} ${sp(`${rAgentDir}/${AGENT_SCRIPT_LEGACY_CMD_FILENAME}`)}`,
  )
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
 * present, else falls back to a quimby-scoped identity. Re-applied on every launch
 * (the local twin of {@link configureRemoteAgentIdentity}), so fixing the host's
 * identity propagates to existing agents without a rebuild. Idempotent — a plain
 * `git config` overwrite.
 */
export async function configureLocalAgentIdentity(
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
  await configureLocalAgentIdentity(repoRoot, repoDir, agentName)
  return git.getCurrentRef(repoDir)
}

/** Create a local agent's mailbox tree and baseline files (assignment/status, optional instructions). */
async function writeAgentScaffold(
  agentDir: string,
  opts: { agentName: string; agentId: string; runtime?: string },
): Promise<void> {
  // The explicit-lifecycle tree: agents author under out/draft and publish into out/queued;
  // parcels arrive in in/received; status mirrors sit at their own `status/` root.
  await ensureDir(join(agentDir, 'handoff', 'out', 'draft'))
  await ensureDir(join(agentDir, 'handoff', 'out', 'queued'))
  await ensureDir(join(agentDir, 'handoff', 'in', 'received'))
  await ensureDir(join(agentDir, 'status'))
  await writeText(join(agentDir, 'assignment.md'), '')
  await writeText(join(agentDir, 'status.md'), 'idle')
  await writeAgentInstructions(agentDir, opts)
}

/**
 * Write a local agent's Quimby-tier instruction files — `CLAUDE.md` (Claude Code) and `AGENTS.md`
 * (Codex et al.), both carrying the shared context. Quimby-owned and regenerated, so it is called
 * both at scaffold time and on every launch, so newer instructions reach an existing agent without
 * a rebuild. The repo's own `repo/CLAUDE.md`/`repo/AGENTS.md` are a separate tier the tools
 * discover natively and quimby never touches.
 */
export async function writeAgentInstructions(
  agentDir: string,
  opts: { agentName: string; agentId: string; runtime?: string },
): Promise<void> {
  await writeText(join(agentDir, 'CLAUDE.md'), renderAgentClaudeMd(opts))
  await writeText(join(agentDir, 'AGENTS.md'), renderAgentAgentsMd(opts))
  // The agent-side coordination tool: quimby-owned and regenerated like the instruction files, so
  // a newer tool reaches an existing agent on its next launch. The .sh is canonical (POSIX floor);
  // the .cmd twin is the Windows fallback. The old quimby-agent.* names are removed on each launch
  // (not shimmed), so a renamed tool propagates without a rebuild and the dir shows only the current
  // tool.
  const shPath = join(agentDir, AGENT_SCRIPT_SH_FILENAME)
  await writeText(shPath, renderAgentScript())
  await chmod(shPath, 0o755)
  await writeText(join(agentDir, AGENT_SCRIPT_CMD_FILENAME), renderAgentScriptCmd())
  await rm(join(agentDir, AGENT_SCRIPT_LEGACY_SH_FILENAME), { force: true })
  await rm(join(agentDir, AGENT_SCRIPT_LEGACY_CMD_FILENAME), { force: true })
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

/**
 * Empty an agent's mailbox in place: remove the parcels within each tray but keep the tray
 * directories (and `handoff/in`, `handoff/out` above them) as the *same inodes*. This is the
 * inode-stable alternative to `rm -rf handoff` — under a virtiofs/9p guest mount, replacing those
 * directory inodes leaves the guest holding a stale dentry (the dir lists via getdents but stat's
 * ENOENT until the guest cache is dropped, which needs root), breaking the agent's next handoff.
 * A tray that does not exist yet is skipped; `writeAgentScaffold` recreates the canonical ones.
 */
async function clearMailboxContents(agentDir: string): Promise<void> {
  for (const tray of MAILBOX_TRAYS) {
    const dir = join(agentDir, tray)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    await Promise.all(entries.map((e) => rm(join(dir, e), { recursive: true, force: true })))
  }
}

// Derive an agent label when `add` is called with no name: auto-label from the role's slot.
// Without a role there is nothing to auto-name from, so this is a user error, not a silent guess.
function autoAgentName(state: Readonly<QuimbyState>, role: string | undefined): string {
  if (!role) {
    throw new QuimbyError(
      'Provide an agent name, or a --role to auto-name from (e.g. `quimby add --role builder`).',
    )
  }
  return generateAgentName(new Set(Object.keys(state.agents)), role)
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

// The mailbox trays emptied on rebuild (relative to the agent dir), plus the `status/` mirror
// root. Their parent directories (`handoff/in`, `handoff/out`) are kept inode-stable by clearing
// only the parcels inside these leaves. Shared by the local `clearMailboxContents` and the SSH
// remote-clear in `rebuildAgent`.
const MAILBOX_TRAYS: readonly string[] = [
  'handoff/out/draft',
  'handoff/out/queued',
  'handoff/out/sent',
  'handoff/in/received',
  'handoff/in/processed',
  'status',
]
