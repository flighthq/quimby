import { join } from 'pathe'

/**
 * The name of Quimby's on-disk state directory at a project root. Quimby's own
 * control-plane state lives here, so it must never cross the boundary: work
 * capture excludes it structurally (not merely via `.gitignore`, which a fresh
 * project may lack) so a diff/handoff/apply can never carry `.quimby` itself.
 */
export const QUIMBY_DIRNAME = '.quimby'

export function getQuimbyDir(repoRoot: string): string {
  return join(repoRoot, QUIMBY_DIRNAME)
}

export function getStatePath(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'state.yaml')
}

// The tmux config Quimby runs its isolated server with (`tmux -L quimby -f …`).
export function getTmuxConfigPath(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'tmux.conf')
}

export function getAgentsDir(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'agents')
}

// Agent directories are keyed by the agent's stable UUID (`AgentState.id`), not its
// name, so renaming an agent never moves its directory — the sandbox and tmux session
// bound to that path survive the rename, while a genuine relocation (the whole .quimby
// moving) still changes the absolute path and recreates the sandbox.
export function getAgentDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId)
}

export function getAgentRepoDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'repo')
}

// Durable transcript of the agent's tmux pane, appended via `pipe-pane` on launch and
// tailed by `quimby log --follow`. Survives detaches and context resets, unlike the
// live scrollback (bounded by history-limit).
export function getAgentSessionLogPath(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'session.log')
}

// The host loading dock: a parcel is assembled here while being applied or carried,
// then discarded. Transient staging, never an archive.
export function getStagingDir(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'staging')
}

export function getStagingHandoffDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'staging', name)
}

export function getAgentInboxDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'inbox')
}

// A delivered parcel sits directly in the inbox, named by sender + contents. The
// recipient is keyed by id (its own directory); the parcel name stays content-derived.
export function getAgentInboxParcelDir(
  repoRoot: string,
  agentId: string,
  parcelName: string,
): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'inbox', parcelName)
}

// Where an agent moves parcels it has processed.
export function getAgentInboxDoneDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'inbox', '.done')
}

export function getAgentInboxStatusDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'inbox', 'status')
}

export function getAgentOutboxDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'outbox')
}

// A staged parcel awaiting pickup. The owning agent is keyed by id; the draft is
// addressed by recipient *name* (how the agent inside its sandbox addresses peers).
export function getAgentOutboxDraftDir(
  repoRoot: string,
  agentId: string,
  recipient: string,
): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'outbox', recipient)
}

// The delivery ledger: parcels already carried, moved aside on success.
export function getAgentOutboxSentDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'outbox', '.sent')
}

export function getAgentOutboxSentDraftDir(
  repoRoot: string,
  agentId: string,
  recipient: string,
): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'outbox', '.sent', recipient)
}
