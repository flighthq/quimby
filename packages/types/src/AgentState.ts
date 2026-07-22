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
  /**
   * The config role the agent was created from, if any. Stored as a *reference*: the runtime
   * profile / entrypoint are resolved from current config through this role at launch, so a
   * profile or role edit (including a rename) propagates to the agent without re-creating it.
   * `defaults` is the fallback when no role is recorded (e.g. created from explicit flags).
   */
  role?: string
  /**
   * A deliberate per-instance runtime-profile pin that OVERRIDES the agent's role engine at
   * launch — unlike `defaults.runtimeProfile`, which is a stale snapshot the role beats (see
   * `resolveAgentLaunchDefaults`). Set by `quimby add --role X --profile Y` so a same-role +1
   * can run a different engine (a Codex `builder` beside Claude `builder`s). The pinned profile
   * fully determines runtime + entrypoint, so the role's own engine is dropped when this is set.
   */
  runtimeProfile?: string
  defaults?: AgentDefaults
  /**
   * Fingerprint of the resolved launch command (runtime + entrypoint) the agent's live tmux
   * session was last (re)created with. Compared against the freshly-resolved command on `run`/
   * `start` to warn when a running session has drifted from current config; refreshed by
   * `restart`. It tracks the *resolved command*, not the role/profile name, so a rename that
   * resolves to the same command is not flagged as drift.
   */
  launchedWith?: string
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
