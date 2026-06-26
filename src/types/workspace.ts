export interface WorkspaceState {
  name: string
  sourceRepo: string
  sourceRepoPath: string
  sourceRef: string
  snapshot: string
  createdAt: string
  sandboxes: Record<string, SandboxState>
}

export interface SandboxState {
  name: string
  status: 'idle' | 'running' | 'stopped' | 'error'
  pid?: number
  runtimeType: string
  seedCommit: string
  createdAt: string
  lastStartedAt?: string
  lastStoppedAt?: string
  host?: string
  user?: string
  port?: number
  remotePath?: string
}
