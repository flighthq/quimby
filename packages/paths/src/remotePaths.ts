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

export function remoteTmuxConfigPath(projectId: string, base?: string): string {
  return `${remoteQuimbyDir(projectId, base)}/tmux.conf`
}

// ── Stable identifiers ────────────────────────────────────────────────────────

// Quimby runs its tmux sessions on a dedicated server socket, so they never mix with
// the user's own sessions and Quimby's config never leaks into the default server.
export const quimbyTmuxSocket = 'quimby'

/**
 * Dashboard session name for multi-agent `quimby run`. Keyed by project id so
 * different projects on the same socket don't collide with each other or with
 * per-agent sessions (`qb-<agentId>`).
 */
export function dashboardSessionName(projectId: string): string {
  return `qb-dash-${projectId.slice(0, 8)}`
}

/**
 * Shared name prefix for the ephemeral tab-group ("view") sessions of one panel dashboard.
 * The bubble-up teardown sweeps the whole group by matching this prefix (agents live under
 * the separate `qb-<agentId>` namespace, so they are never swept).
 */
export function dashboardViewPrefix(projectId: string): string {
  return `qbv-${projectId.slice(0, 8)}-`
}

/**
 * Ephemeral "view" session backing one pane of a panel dashboard — a tabbed session that
 * link-windows the agents of that pane. Keyed by project id + pane index.
 */
export function dashboardViewSessionName(projectId: string, index: number): string {
  return `${dashboardViewPrefix(projectId)}${index}`
}

/**
 * tmux session name derived from the agent's stable id — unaffected by quimby rename.
 * The agent id is globally unique, so it alone names the session; the human-facing
 * label is the tmux *window* title (set to the agent's display name on `run`).
 */
export function tmuxSessionName(agentId: string): string {
  return `qb-${agentId.slice(0, 8)}`
}
