// ── Remote paths (SSH agents) ────────────────────────────────────────────────
// Paths use ~ which the remote shell expands; never use these in local fs ops.

export function remoteProjectRoot(projectId: string, base?: string): string {
  return base ?? `~/.quimby/workspaces/${projectId}`
}

export function remoteQuimbyDir(projectId: string, base?: string): string {
  return `${remoteProjectRoot(projectId, base)}/.quimby`
}

// Remote agent dirs are keyed by the agent's stable UUID, mirroring the local layout
// (see getAgentDir) so a rename never moves the remote directory either.
export function remoteAgentDir(projectId: string, agentId: string, base?: string): string {
  return `${remoteQuimbyDir(projectId, base)}/agents/${agentId}`
}

export function remoteAgentRepoDir(projectId: string, agentId: string, base?: string): string {
  return `${remoteAgentDir(projectId, agentId, base)}/repo`
}

// ── Stable identifiers ────────────────────────────────────────────────────────

/** tmux session name derived from stable IDs — unaffected by quimby rename. */
export function tmuxSessionName(projectId: string, agentId: string): string {
  return `qb-${projectId.slice(0, 8)}-${agentId.slice(0, 8)}`
}
