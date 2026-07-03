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

export function getProjectConfigPath(repoRoot: string): string {
  return join(repoRoot, 'quimby.yaml')
}

export function getLocalConfigPath(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'local.yaml')
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

// The mailbox is an explicit-lifecycle tree: state is a directory *level* above the party
// name (`handoff/out/queued/<recipient>`, `handoff/in/received/<sender>-<hash>`), never a
// dot-prefix. This is self-documenting and collision-safe — a scanner enumerates the fixed
// state dirs and reads party names as the leaves, so an agent may be named anything. Direction
// (`in`/`out`) groups the trays; `status/` sits outside `handoff/` because it is a live
// overwritten mirror, not a discrete parcel.
export function getAgentHandoffDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'handoff')
}

// `out/draft/<recipient>` — the agent's authoring space. **Not scanned**: an agent writes a
// parcel here, then publishes it with one atomic same-fs `mv` into `out/queued/`, so a partial
// parcel never appears as queued (the race fix by construction). Addressed by recipient name.
export function getAgentHandoffOutDraftDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'handoff', 'out', 'draft')
}

export function getAgentHandoffOutDraftRecipientDir(
  repoRoot: string,
  agentId: string,
  recipient: string,
): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'handoff', 'out', 'draft', recipient)
}

// `out/queued/<recipient>` — finalized parcels awaiting transmit; the scan root Quimby carries
// from (was `outbox/<recipient>`).
export function getAgentHandoffOutQueuedDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'handoff', 'out', 'queued')
}

export function getAgentHandoffOutQueuedRecipientDir(
  repoRoot: string,
  agentId: string,
  recipient: string,
): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'handoff', 'out', 'queued', recipient)
}

// `out/sent/<recipient>` — the sender's delivery ledger; a carried parcel is moved here on
// success (was `outbox/.sent/<recipient>`).
export function getAgentHandoffOutSentDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'handoff', 'out', 'sent')
}

export function getAgentHandoffOutSentRecipientDir(
  repoRoot: string,
  agentId: string,
  recipient: string,
): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'handoff', 'out', 'sent', recipient)
}

// `in/received/<sender>-<hash>` — delivered parcels awaiting processing; content-named, since on
// receipt the question is "what did I get, and from whom" (was `inbox/<sender>-<hash>`).
export function getAgentHandoffInReceivedDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'handoff', 'in', 'received')
}

export function getAgentHandoffInReceivedParcelDir(
  repoRoot: string,
  agentId: string,
  parcelName: string,
): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'handoff', 'in', 'received', parcelName)
}

// `in/processed/<sender>-<hash>` — parcels the recipient has acted on (was `inbox/.done/…`).
export function getAgentHandoffInProcessedDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'handoff', 'in', 'processed')
}

// `status/<peer>.md` — live status mirrors the server overwrites each poll. Its own root at the
// agent level (not under `handoff/`), because status is a continuously-updated reflection, not a
// discrete immutable parcel (was `inbox/status/`).
export function getAgentStatusMirrorDir(repoRoot: string, agentId: string): string {
  return join(repoRoot, '.quimby', 'agents', agentId, 'status')
}
