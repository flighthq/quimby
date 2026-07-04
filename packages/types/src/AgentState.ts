import type { AgentLocation } from './AgentLocation'

export interface AgentDefaults {
  /** Named runtime profile from quimby config. The profile is resolved at launch time. */
  runtimeProfile?: string
  runtime?: string
  /** The command launched in the agent (overloaded to include args); a runtime adapter wraps it. */
  entrypoint?: string
}

export interface AgentState {
  id: string
  name: string
  seedCommit: string
  /**
   * Ref the agent synchronizes against (e.g. `main`, `refs/heads/release`).
   * `quimby sync` resolves this ref's tip in the host repo as the new baseline —
   * it does NOT follow whatever the host happens to be checked out to. Retarget
   * explicitly with `quimby set <agent> --sync <ref>`.
   */
  syncRef?: string
  createdAt: string
  location?: AgentLocation
  defaults?: AgentDefaults
  /**
   * Run the agent inside a named tmux session. SSH agents always use tmux for
   * persistence; this opts a local agent into the same behavior.
   */
  tmux?: boolean
  /**
   * The agent's own verification command (e.g. `npm run ci`), run *inside* its sandbox when
   * asked to self-verify (`nudge --verify`, `assign --verify`, or the CLAUDE.md convention).
   * Quimby never runs it — it only relays the agent's attestation. Unset ⇒ a generic request.
   */
  check?: string
  /** Advisory check request default. Quimby asks the agent to attest; it never gates a merge. */
  verifyByDefault?: boolean
}
