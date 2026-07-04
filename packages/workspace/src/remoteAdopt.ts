import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { remoteProjectRoot } from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import type { AgentState, QuimbyConfig, QuimbyState, SSHLocation } from '@quimbyhq/types'
import { execa } from 'execa'

import {
  normalizeCheck,
  resolveAgentRoleConfig,
  resolveConfiguredAgent,
  resolvePreset,
  resolveSSHConnection,
} from './config'
import { saveState } from './state'
import { ensureDurableWorkspace } from './storage'

export interface RemoteProject {
  id: string
  sourceRepo: string
  sourceRef?: string
}

export interface RemoteAgent {
  id: string
  name: string
  seedCommit: string
}

/** An alias declared in config that resolves to a concrete (bound) SSH address. */
export interface BoundHostAlias {
  alias: string
  location: SSHLocation & { host: string }
}

/**
 * The bound aliases declared in layered config, in declaration order. An alias whose
 * address is not bound in private config is skipped — silent adoption never prompts,
 * so it only considers hosts it can already reach.
 */
export function boundHostAliases(config: Readonly<QuimbyConfig>): BoundHostAlias[] {
  const bound: BoundHostAlias[] = []
  for (const alias of Object.keys(config.hosts ?? {})) {
    const res = resolveSSHConnection(config, { type: 'ssh', alias })
    if (res.location) bound.push({ alias, location: res.location })
  }
  return bound
}

/** Scan a remote host for quimby project workspaces (id + git origin + branch). */
export async function scanRemoteProjects(
  location: Readonly<SSHLocation & { host: string }>,
): Promise<RemoteProject[]> {
  const transport = getSSHTransport(location)
  return parseRemoteProjects(await transport.exec(remoteProjectScanScript()))
}

/**
 * Rebuild local `state.yaml` from a remote project workspace: scan its agents, map each
 * back onto config roles, then materialize durable storage and save. The
 * recovered agents store the alias *reference* (not a flattened address), so the concrete
 * host resolves from private config at launch. Throws if the remote workspace has no agents.
 */
export async function reconstructRemoteWorkspace(
  repoRoot: string,
  location: Readonly<SSHLocation & { host: string }>,
  config: Readonly<QuimbyConfig>,
  project: Readonly<RemoteProject>,
  opts: Readonly<{ presetName: string; fallbackAlias: string; sourceRepo: string }>,
): Promise<QuimbyState> {
  const transport = getSSHTransport(location)
  const remoteAgents = parseRemoteAgents(
    await transport.exec(remoteAgentScanScript(remoteProjectRoot(project.id, location.base))),
  )
  if (remoteAgents.length === 0) {
    throw new QuimbyError(`Remote workspace "${project.id}" has no recoverable agents.`)
  }

  const preset = config.presets?.[opts.presetName] ? resolvePreset(config, opts.presetName) : {}
  const sourceRef = await getCurrentBranch(repoRoot)
  const snapshot = await git.getCurrentRef(repoRoot)
  const now = new Date().toISOString()
  const agents: Record<string, AgentState> = {}
  for (const remoteAgent of remoteAgents) {
    const raw = preset.agents?.[remoteAgent.name]
    const configured = resolveConfiguredAgent(config, raw)
    const role = resolveAgentRoleConfig(config, configured)
    const check = normalizeCheck(role.check)
    const agentAliasName = configured.hostAlias ?? opts.fallbackAlias
    agents[remoteAgent.name] = {
      id: remoteAgent.id,
      name: remoteAgent.name,
      seedCommit: remoteAgent.seedCommit || snapshot,
      syncRef: sourceRef,
      createdAt: now,
      location: configured.location ?? { type: 'ssh', alias: agentAliasName },
      ...(configured.role ? { role: configured.role } : {}),
      ...(role.runtimeProfile || role.runtime || role.entrypoint
        ? {
            defaults: {
              ...(role.runtimeProfile ? { runtimeProfile: role.runtimeProfile } : {}),
              ...(role.runtime ? { runtime: role.runtime } : {}),
              ...(role.entrypoint ? { entrypoint: role.entrypoint } : {}),
            },
          }
        : {}),
      ...(role.tmux ? { tmux: true } : {}),
      ...(check?.command ? { check: check.command } : {}),
      ...((check?.verifyByDefault ?? role.verifyByDefault) ? { verifyByDefault: true } : {}),
    }
  }

  const state: QuimbyState = {
    id: project.id,
    sourceRepo: opts.sourceRepo,
    sourceRef,
    snapshot,
    createdAt: now,
    agents,
  }

  await ensureDurableWorkspace(repoRoot, state)
  await saveState(repoRoot, state)
  return state
}

/**
 * Silently reconnect to an existing remote workspace for this repo, so that running a
 * configured workspace after `.quimby/` is lost reuses the remote namespace rather than
 * minting a fresh one and orphaning the old agents. Scans every *bound* host alias for a
 * workspace whose git origin matches `sourceRepo`, deduped by project id:
 *
 * - **exactly one** → adopt it (reconstruct + save), returning the state
 * - **none** → `null` (the caller creates a fresh workspace or errors)
 * - **more than one** → throw, since the choice of lane is the user's to make
 *
 * An unreachable alias is skipped, never fatal — a dead VPN or sleeping host degrades to
 * "no match found" instead of breaking an offline command. Returns `null` immediately when
 * no bound SSH alias is declared, so a purely-local project never touches the network.
 */
export async function adoptRemoteWorkspace(
  repoRoot: string,
  config: Readonly<QuimbyConfig>,
  opts: Readonly<{ sourceRepo: string }>,
): Promise<QuimbyState | null> {
  const aliases = boundHostAliases(config)
  if (aliases.length === 0) return null

  const found = new Map<string, { project: RemoteProject; location: BoundHostAlias }>()
  for (const bound of aliases) {
    let projects: RemoteProject[]
    try {
      projects = await withTimeout(scanRemoteProjects(bound.location), remoteProbeTimeoutMs())
    } catch {
      continue // unreachable / timed-out host — skip, never fatal
    }
    for (const project of projects) {
      if (project.sourceRepo === opts.sourceRepo && !found.has(project.id)) {
        found.set(project.id, { project, location: bound })
      }
    }
  }

  const matches = [...found.values()]
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw new QuimbyError(
      `Multiple remote quimby workspaces match this repository: ${matches
        .map((m) => m.project.id)
        .join(', ')}. Run \`quimby restore --host <alias> --id <id>\` to choose one.`,
    )
  }

  const { project, location } = matches[0]
  return reconstructRemoteWorkspace(repoRoot, location.location, config, project, {
    presetName: location.alias,
    fallbackAlias: location.alias,
    sourceRepo: opts.sourceRepo,
  })
}

/**
 * Remote garbage collection: the duplicate workspaces the pre-adopt behavior could leave
 * on a host. Scans `location` for workspaces whose git origin is `sourceRepo` but whose id
 * is not `keepId` (the active workspace) — those are orphaned lanes for this repo. Returns
 * them for preview; with `force`, removes each remote directory. Never touches other repos'
 * workspaces or the active one. `keepId` is required by callers precisely so a prune can
 * never delete the lane you are on.
 */
export async function pruneRemoteWorkspaces(
  location: Readonly<SSHLocation & { host: string }>,
  opts: Readonly<{ sourceRepo: string; keepId: string; force?: boolean }>,
): Promise<RemoteProject[]> {
  const projects = await scanRemoteProjects(location)
  const stale = projects.filter((p) => p.sourceRepo === opts.sourceRepo && p.id !== opts.keepId)
  if (opts.force && stale.length > 0) {
    const transport = getSSHTransport(location)
    for (const project of stale) {
      // The id came from scanning `~/.quimby/workspaces/*`, so this removes a real, matched
      // directory in that namespace — quoted to keep the id out of shell interpretation.
      await transport.exec(`rm -rf ~/.quimby/workspaces/${shellQuote(project.id)}`)
    }
  }
  return stale
}

function remoteProbeTimeoutMs(): number {
  const raw =
    process.env.QUIMBY_REMOTE_PROBE_TIMEOUT_MS ?? process.env.QUIMBY_REMOTE_STATUS_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5_000
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new QuimbyError('remote probe timed out')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function getCurrentBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
    return stdout.trim()
  } catch {
    return 'main'
  }
}

function remoteProjectScanScript(): string {
  return [
    'for p in ~/.quimby/workspaces/*; do',
    '[ -d "$p/.quimby/agents" ] || continue;',
    'id=${p##*/};',
    'source=$(git -C "$p" remote get-url origin 2>/dev/null || true);',
    'branch=$(git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null || true);',
    'printf "PROJECT\\t%s\\t%s\\t%s\\n" "$id" "$source" "$branch";',
    'done',
  ].join(' ')
}

function remoteAgentScanScript(remoteRoot: string): string {
  return [
    remoteRootAssignment(remoteRoot),
    'for a in "$root"/.quimby/agents/*; do',
    '[ -d "$a" ] || continue;',
    'id=${a##*/};',
    'name=$(sed -n "s/^You are the \\*\\*\\(.*\\)\\*\\* agent\\.$/\\1/p" "$a/CLAUDE.md" 2>/dev/null | head -n 1);',
    '[ -n "$name" ] || name="$id";',
    'seed=$(git -C "$a/repo" rev-parse quimby/seed 2>/dev/null || git -C "$a/repo" rev-parse HEAD 2>/dev/null || true);',
    'printf "AGENT\\t%s\\t%s\\t%s\\n" "$id" "$name" "$seed";',
    'done',
  ].join(' ')
}

function remoteRootAssignment(remoteRoot: string): string {
  if (remoteRoot === '~') return 'root=$HOME;'
  if (remoteRoot.startsWith('~/')) {
    return `root=$HOME/${remoteRoot.slice(2).split('/').map(shellQuote).join('/')};`
  }
  return `root=${shellQuote(remoteRoot)};`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function parseRemoteProjects(output: string): RemoteProject[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('PROJECT\t'))
    .map((line) => {
      const [, id, sourceRepo, sourceRef] = line.split('\t')
      return { id, sourceRepo, sourceRef }
    })
}

function parseRemoteAgents(output: string): RemoteAgent[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('AGENT\t'))
    .map((line) => {
      const [, id, name, seedCommit] = line.split('\t')
      return { id, name, seedCommit }
    })
}
