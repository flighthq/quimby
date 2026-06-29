// ── Remote paths (SSH agents) ────────────────────────────────────────────────
// Paths use ~ which the remote shell expands; never use these in local fs ops.

export function remoteProjectRoot(projectId: string, base?: string): string {
  return base ?? `~/.quimby/workspaces/${projectId}`
}

export function remoteQuimbyDir(projectId: string, base?: string): string {
  return `${remoteProjectRoot(projectId, base)}/.quimby`
}

export function remoteAgentDir(projectId: string, name: string, base?: string): string {
  return `${remoteQuimbyDir(projectId, base)}/agents/${name}`
}

export function remoteAgentRepoDir(projectId: string, name: string, base?: string): string {
  return `${remoteAgentDir(projectId, name, base)}/repo`
}

// ── Stable identifiers ────────────────────────────────────────────────────────

/** tmux session name derived from stable IDs — unaffected by quimby rename. */
export function tmuxSessionName(projectId: string, agentId: string): string {
  return `qb-${projectId.slice(0, 8)}-${agentId.slice(0, 8)}`
}
