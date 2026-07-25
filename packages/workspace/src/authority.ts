import type { QuimbyState } from '@quimbyhq/types'

/**
 * The concrete recipients an agent may DIRECT — its `directs` entries with any `@role` slot
 * expanded to every instance of that role (mirroring the layout role-slot rule: an agent whose
 * `role` is that role, or is literally named it). See coordination-proposals §6.
 */
export function resolveDirectedRecipients(state: Readonly<QuimbyState>, from: string): string[] {
  const directs = state.agents[from]?.directs
  if (!directs?.length) return []
  const out = new Set<string>()
  for (const entry of directs) {
    if (entry.length > 1 && entry.startsWith('@')) {
      const role = entry.slice(1)
      for (const [name, agent] of Object.entries(state.agents)) {
        if (agent.role === role || name === role) out.add(name)
      }
    } else {
      out.add(entry)
    }
  }
  return [...out]
}

/**
 * Does `from` DIRECT `to` — a declared `directs` edge? A directed handoff along this edge is
 * host-stamped `userDirected` and interrupts the recipient (coordination-proposals §6/§6a).
 */
export function directsRecipient(state: Readonly<QuimbyState>, from: string, to: string): boolean {
  return resolveDirectedRecipients(state, from).includes(to)
}

/**
 * The agent `from` escalates to: an explicit `escalatesTo` override, else the inverse of `directs`
 * (the agent that directs `from`). Undefined when nothing directs it (e.g. the top-level agent).
 * See coordination-proposals §6b.
 */
export function escalationTarget(state: Readonly<QuimbyState>, from: string): string | undefined {
  const override = state.agents[from]?.escalatesTo
  if (override) return override
  for (const name of Object.keys(state.agents)) {
    if (name !== from && directsRecipient(state, name, from)) return name
  }
  return undefined
}

/**
 * Is `to` a permitted escalation target for `from` (its director / `escalatesTo`)? An `--escalate`
 * aimed anywhere else is normalized to an ordinary advisory (coordination-proposals §6b).
 */
export function honorsEscalation(state: Readonly<QuimbyState>, from: string, to: string): boolean {
  return escalationTarget(state, from) === to
}
