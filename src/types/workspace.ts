export interface QuimbyState {
  id: string
  sourceRepo: string
  sourceRef: string
  snapshot: string
  createdAt: string
  workers: Record<string, WorkerState>
  subscriptions?: Record<string, string[]>
}

export interface WorkerState {
  id: string
  name: string
  seedCommit: string
  createdAt: string
  defaults?: {
    runtime?: string
    agent?: string
  }
}
