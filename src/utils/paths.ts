import { join } from 'pathe'

export function getQuimbyDir(repoRoot: string): string {
  return join(repoRoot, '.quimby')
}

export function getStatePath(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'state.yaml')
}

export function getWorkersDir(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'workers')
}

export function getWorkerDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'workers', name)
}

export function getWorkerRepoDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'workers', name, 'repo')
}

export function getPacksDir(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'packs')
}

export function getPackDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'packs', name)
}

export function getWorkerInboxDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'workers', name, 'inbox')
}

export function getWorkerInboxPackDir(
  repoRoot: string,
  workerName: string,
  packName: string,
): string {
  return join(repoRoot, '.quimby', 'workers', workerName, 'inbox', 'packs', packName)
}

export function getWorkerInboxStatusDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'workers', name, 'inbox', 'status')
}

export function getWorkerOutboxDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'workers', name, 'outbox')
}

export function getWorkerOutboxFile(repoRoot: string, workerName: string, target: string): string {
  return join(repoRoot, '.quimby', 'workers', workerName, 'outbox', `${target}.md`)
}

// ── Remote paths (SSH workers) ────────────────────────────────────────────────
// Paths use ~ which the remote shell expands; never use these in local fs ops.

export function remoteProjectRoot(projectId: string, base?: string): string {
  return base ?? `~/.quimby/workspaces/${projectId}`
}

export function remoteQuimbyDir(projectId: string, base?: string): string {
  return `${remoteProjectRoot(projectId, base)}/.quimby`
}

export function remoteWorkerDir(projectId: string, name: string, base?: string): string {
  return `${remoteQuimbyDir(projectId, base)}/workers/${name}`
}

export function remoteWorkerRepoDir(projectId: string, name: string, base?: string): string {
  return `${remoteWorkerDir(projectId, name, base)}/repo`
}

export function remotePacksDir(projectId: string, base?: string): string {
  return `${remoteQuimbyDir(projectId, base)}/packs`
}

export function remotePackDir(projectId: string, packName: string, base?: string): string {
  return `${remotePacksDir(projectId, base)}/${packName}`
}

// ── Stable identifiers ────────────────────────────────────────────────────────

/** tmux session name derived from stable IDs — unaffected by quimby rename. */
export function tmuxSessionName(projectId: string, workerId: string): string {
  return `qb-${projectId.slice(0, 8)}-${workerId.slice(0, 8)}`
}
