/**
 * The coordination edges declared for an agent in config (coordination-proposals §6): who it may
 * DIRECT, and where it escalates. Resolved from `quimby.yaml` and applied onto `AgentState` — at
 * creation, and refreshed on every `quimby sync` — so editing the graph reaches existing agents
 * without a rebuild.
 */
export interface AgentCoordinationEdges {
  /** Agents this one may direct — names or a `@role` slot. Empty/absent ⇒ an advisory peer. */
  directs?: string[]
  /** Who this agent may escalate to (else every agent that directs it) — an allow-list. */
  escalatesTo?: string | string[]
}
