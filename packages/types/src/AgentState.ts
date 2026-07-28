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
  /**
   * Whether the agent participates in launches. Absent ⇒ enabled (the default; purely additive).
   * `false` ⇒ disabled: retained on disk (repo, mailbox, assignment, status) but dropped from
   * layout placement and never launched (`quimby disable`/`enable`). The middle rung between
   * `stop` (transient session end) and `remove` (destructive) — the binding fleet constraint is
   * live sessions, not disk.
   */
  enabled?: boolean
  /**
   * Agents this one may DIRECT on its own initiative (coordination-proposals §6). Copied from the
   * agent's config entry at creation; a directed handoff along this edge is host-stamped
   * `userDirected` and interrupts the recipient. Entries are agent names or a `@role` slot. The
   * escalation target is the inverse of this edge unless `escalatesTo` overrides it.
   */
  directs?: string[]
  /**
   * Who this agent may escalate to, overriding the default (every agent that directs it). A list is
   * an ALLOW-LIST, not a fan-out: the agent names one recipient per escalation, and only that one
   * is woken. Entries are agent names or a `@role` slot. A bare string is one permitted target.
   * See coordination-proposals §6b.
   */
  escalatesTo?: string | string[]
}
