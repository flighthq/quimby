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

/**
 * tmux session name derived from the agent's stable id — unaffected by quimby rename.
 * The agent id is globally unique, so it alone names the session; the human-facing
 * label is the tmux *window* title (set to the agent's display name on `run`).
 */
export function tmuxSessionName(agentId: string): string {
  return `qb-${agentId.slice(0, 8)}`
}
