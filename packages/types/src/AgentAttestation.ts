/**
 * An agent's self-reported verification outcome, parsed from a `quimby-attest` fenced block
 * it appends to its `status.md`. Quimby relays this at the boundary — it never runs the check
 * itself, and never gates on the result. `atCommit` is the agent's content-hash at attest time,
 * used to flag staleness (live hash ≠ atCommit ⇒ the work changed since it verified).
 */
export interface AgentAttestation {
  command: string
  result: 'pass' | 'fail'
  summary?: string
  atCommit?: string
}
