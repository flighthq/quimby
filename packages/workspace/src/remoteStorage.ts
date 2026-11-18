import type { SandboxSweepResult } from '@quimbyhq/runtimes'
import { sweepAgentSandboxes } from '@quimbyhq/runtimes'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { SSHLocation } from '@quimbyhq/types'

import type { RemoteDiskUsage } from './remoteUsage'
import { parseRemoteDiskUsage, remoteSandboxShellRunner } from './remoteUsage'

/** One workspace directory found under `~/.quimby/workspaces` on a remote host. */
export interface RemoteWorkspaceInfo {
  id: string
  /** The clone's git origin, absent when the directory holds no readable repo. */
  sourceRepo?: string
  sourceRef?: string
  /**
   * Agent directories inside it. `0` means provisioned but empty; **undefined** means the
   * workspace has no `.quimby/agents` at all — a half-provisioned lane, which matters because
   * the adopt/prune scan skips exactly those, so they are invisible to every other command.
   */
  agents?: number
  /** Disk usage in KB (`du -sk`), so a listing can rank what is actually worth reclaiming. */
  sizeKb?: number
}

/** Everything a remote storage command needs up front, from ONE round trip. */
export interface RemoteHostOverview {
  disk: RemoteDiskUsage | null
  workspaces: RemoteWorkspaceInfo[]
  /** Session names on the host's quimby tmux socket. */
  liveSessions: Set<string>
}

/**
 * The host's disk, its workspaces and its live sessions in a single SSH invocation.
 *
 * Each of these used to be its own round trip, run back to back before the first line of output —
 * cheap over loopback, but on a loaded host every invocation pays a remote shell and process
 * spawns, and a command that prints nothing for that long reads as hung. The listing is unsized
 * for the same reason; `du` happens per workspace, in parallel, as rows are printed.
 */
export async function getRemoteHostOverview(
  location: Readonly<SSHLocation & { host: string }>,
): Promise<RemoteHostOverview> {
  const out = await getSSHTransport(location).exec(
    [
      'df -Pk "$HOME/.quimby" 2>/dev/null || df -Pk "$HOME" 2>/dev/null;',
      `${remoteWorkspaceScanScript()};`,
      `tmux -L quimby list-sessions -F 'QBLS\t#{session_name}' 2>/dev/null;`,
      'true',
    ].join(' '),
  )
  return parseRemoteHostOverview(out)
}

/**
 * A human name for a remote workspace: its repository's name (`flight-rs-new`), or undefined when
 * it has no origin. Ids stay the handle for commands; this is what makes a listing readable.
 */
export function getRemoteWorkspaceLabel(sourceRepo: string | undefined): string | undefined {
  if (!sourceRepo) return undefined
  const name = sourceRepo
    .replace(/[/\\]+$/, '')
    .split(/[/:\\]/)
    .at(-1)
    ?.replace(/\.git$/, '')
  return name || undefined
}

/**
 * Resolve a full workspace id or a unique prefix of one (at least 8 characters, like the short ids
 * listings print). A prefix matching several is refused with the candidates, never guessed — these
 * ids feed deletions.
 */
export function resolveRemoteWorkspaceId(
  ids: readonly string[],
  query: string,
): { id: string } | { error: string } {
  if (ids.includes(query)) return { id: query }
  if (query.length < 8) {
    return { error: `"${query}" is too short to identify a workspace — use at least 8 characters.` }
  }
  const matches = ids.filter((id) => id.startsWith(query))
  if (matches.length === 1) return { id: matches[0] }
  if (matches.length === 0) return { error: `No workspace matches "${query}".` }
  return { error: `"${query}" matches ${matches.length} workspaces: ${matches.join(', ')}.` }
}

/**
 * Remove one remote workspace by id: its agents' runtime sandboxes first, then the directory. The
 * remote twin of `removeStorageWorkspace`, so a listing can be acted on entry by entry.
 *
 * Sandboxes go first because they are named by agent id and the agent ids are read from the
 * directory — delete the directory first and nothing left on the host says which sandboxes were
 * this workspace's. That ordering is the whole reason removing a workspace used to leak them.
 */
export async function removeRemoteWorkspace(
  location: Readonly<SSHLocation & { host: string }>,
  id: string,
): Promise<{ removed: boolean; sandboxes: SandboxSweepResult }> {
  const transport = getSSHTransport(location)
  const path = `$HOME/.quimby/workspaces/${sq(id)}`
  const agentIds = (await transport.exec(`ls -1 ${path}/.quimby/agents 2>/dev/null || true`))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const sandboxes = await sweepAgentSandboxes(remoteSandboxShellRunner(location), agentIds)
  // Report presence from the same invocation that removes it, so the answer cannot be a stale read.
  const out = await transport.exec(
    `if [ -d ${path} ]; then rm -rf ${path} && printf REMOVED; else printf ABSENT; fi`,
  )
  return { removed: out.trim() === 'REMOVED', sandboxes }
}

export function parseRemoteHostOverview(stdout: string): RemoteHostOverview {
  const liveSessions = new Set<string>()
  for (const line of stdout.split('\n')) {
    const [tag, name] = line.split('\t')
    if (tag === 'QBLS' && name?.trim()) liveSessions.add(name.trim())
  }
  return {
    disk: parseRemoteDiskUsage(stdout),
    workspaces: parseRemoteWorkspaces(stdout),
    liveSessions,
  }
}

export function parseRemoteWorkspaces(stdout: string): RemoteWorkspaceInfo[] {
  const out: RemoteWorkspaceInfo[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t')
    if (parts[0] !== MARKER || parts.length < 6) continue
    const [, id, sourceRepo, sourceRef, agents, sizeKb] = parts
    if (!id) continue
    out.push({
      id,
      ...(sourceRepo ? { sourceRepo } : {}),
      ...(sourceRef ? { sourceRef } : {}),
      // `-` distinguishes "no agents dir" (half-provisioned) from a provisioned-but-empty `0`.
      ...(agents === '-' || agents === '' ? {} : { agents: Number(agents) }),
      ...(sizeKb ? { sizeKb: Number(sizeKb) } : {}),
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

// Tab-delimited so a path or branch containing spaces stays in one field, and marker-prefixed so
// shell noise (a login banner, a `du` warning on an unreadable subdir) can never parse as a row.
const MARKER = 'QBWS'

// Deliberately unsized: a `du` here would walk every build tree on the host before the first row,
// which is what made the listing read as hung. Sizes are measured per workspace, in parallel.
function remoteWorkspaceScanScript(): string {
  return [
    'for p in "$HOME"/.quimby/workspaces/*; do',
    '[ -d "$p" ] || continue;',
    'id=${p##*/};',
    'src=$(git -C "$p" remote get-url origin 2>/dev/null || true);',
    'ref=$(git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null || true);',
    'if [ -d "$p/.quimby/agents" ];',
    'then n=$(find "$p/.quimby/agents" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d " ");',
    'else n=-; fi;',
    'kb=;',
    `printf '${MARKER}\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$src" "$ref" "$n" "$kb";`,
    'done',
  ].join(' ')
}
