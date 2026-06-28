import type { WorkerLocation } from './location'

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
  location?: WorkerLocation
  defaults?: {
    runtime?: string
    agent?: string
  }
  /** Shell command run in the worker repo by `quimby pack` to verify the work before it crosses the membrane. */
  check?: string
}
