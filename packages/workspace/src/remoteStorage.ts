import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { SSHLocation } from '@quimbyhq/types'

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

/**
 * Every workspace on a remote host, unfiltered.
 *
 * This is the remote twin of `listStorageWorkspaces`, and it exists because SSH is the primary
 * deployment for a fleet of any size — a laptop runs out of sandboxes long before a remote box
 * does — while the remote side had no listing at all. `prune-remote` previews only the subset
 * matching the repo you run it from, which by construction hides other repos' lanes and the active
 * one; recovering the whole picture meant hand-writing an `ssh … ls`.
 *
 * Deliberately reports lanes the adopt scan skips (no `.quimby/agents`), since a half-provisioned
 * workspace consumes disk while being invisible to `prune-remote` — the exact residue a listing is
 * for. Interpretation stays with the caller: this never decides what is stale.
 */
export async function listRemoteWorkspaces(
  location: Readonly<SSHLocation & { host: string }>,
): Promise<RemoteWorkspaceInfo[]> {
  const transport = getSSHTransport(location)
  return parseRemoteWorkspaces(await transport.exec(remoteWorkspaceScanScript()))
}

/**
 * Remove one remote workspace by id, returning whether it was there. The remote twin of
 * `removeStorageWorkspace`, so a listing can be acted on entry by entry instead of only through
 * `prune-remote`'s whole-subset sweep.
 */
export async function removeRemoteWorkspace(
  location: Readonly<SSHLocation & { host: string }>,
  id: string,
): Promise<boolean> {
  const transport = getSSHTransport(location)
  const path = `$HOME/.quimby/workspaces/${sq(id)}`
  // Report presence from the same invocation that removes it, so the answer cannot be a stale read.
  const out = await transport.exec(
    `if [ -d ${path} ]; then rm -rf ${path} && printf REMOVED; else printf ABSENT; fi`,
  )
  return out.trim() === 'REMOVED'
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
    'kb=$(du -sk "$p" 2>/dev/null | cut -f1);',
    `printf '${MARKER}\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$src" "$ref" "$n" "$kb";`,
    'done',
  ].join(' ')
}
