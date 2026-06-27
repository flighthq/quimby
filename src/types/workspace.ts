export interface QuimbyState {
  sourceRepo: string
  sourceRef: string
  snapshot: string
  createdAt: string
  workers: Record<string, WorkerState>
  subscriptions?: Record<string, string[]>
}

export interface WorkerState {
  name: string
  seedCommit: string
  createdAt: string
}
