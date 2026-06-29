import type { WorkerLocation } from './WorkerLocation'

export interface WorkerState {
  id: string
  name: string
  seedCommit: string
  /**
   * Ref the worker synchronizes against (e.g. `main`, `refs/heads/release`).
   * `quimby advance` resolves this ref's tip in the host repo as the new baseline —
   * it does NOT follow whatever the host happens to be checked out to. Retarget
   * explicitly with `quimby set <worker> --sync <ref>`.
   */
  syncRef?: string
  createdAt: string
  location?: WorkerLocation
  defaults?: {
    runtime?: string
    agent?: string
  }
  /** Shell command run in the worker repo by `quimby pack` to verify the work before it crosses the membrane. */
  check?: string
  /**
   * Run the agent inside a named tmux session. SSH workers always use tmux for
   * persistence; this opts a local worker into the same behavior.
   */
  tmux?: boolean
}
