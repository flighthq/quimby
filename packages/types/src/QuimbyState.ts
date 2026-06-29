import type { WorkerState } from './WorkerState'

export interface QuimbyState {
  id: string
  sourceRepo: string
  sourceRef: string
  snapshot: string
  createdAt: string
  workers: Record<string, WorkerState>
  subscriptions?: Record<string, string[]>
}
