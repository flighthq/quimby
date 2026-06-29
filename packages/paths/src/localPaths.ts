import { join } from 'pathe'

export function getQuimbyDir(repoRoot: string): string {
  return join(repoRoot, '.quimby')
}

export function getStatePath(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'state.yaml')
}

export function getAgentsDir(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'agents')
}

export function getAgentDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'agents', name)
}

export function getAgentRepoDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'agents', name, 'repo')
}

// The host loading dock: a parcel is assembled here while being applied or carried,
// then discarded. Transient staging, never an archive.
export function getStagingDir(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'staging')
}

export function getStagingHandoffDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'staging', name)
}

export function getAgentInboxDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'agents', name, 'inbox')
}

// A delivered parcel sits directly in the inbox, named by sender + contents.
export function getAgentInboxParcelDir(
  repoRoot: string,
  agentName: string,
  parcelName: string,
): string {
  return join(repoRoot, '.quimby', 'agents', agentName, 'inbox', parcelName)
}

// Where an agent moves parcels it has processed.
export function getAgentInboxDoneDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'agents', name, 'inbox', '.done')
}

export function getAgentInboxStatusDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'agents', name, 'inbox', 'status')
}

export function getAgentOutboxDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'agents', name, 'outbox')
}

// A staged parcel awaiting pickup, addressed by recipient.
export function getAgentOutboxDraftDir(
  repoRoot: string,
  agentName: string,
  recipient: string,
): string {
  return join(repoRoot, '.quimby', 'agents', agentName, 'outbox', recipient)
}

// The delivery ledger: parcels already carried, moved aside on success.
export function getAgentOutboxSentDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'agents', name, 'outbox', '.sent')
}

export function getAgentOutboxSentDraftDir(
  repoRoot: string,
  agentName: string,
  recipient: string,
): string {
  return join(repoRoot, '.quimby', 'agents', agentName, 'outbox', '.sent', recipient)
}
