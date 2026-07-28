import type {
  AgentCoordinationEdges,
  AgentState,
  ConfiguredAgent,
  QuimbyConfig,
  QuimbyState,
} from '@quimbyhq/types'

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
 * The coordination edges CONFIG declares for an agent — its preset entry's `directs`/`escalatesTo`,
 * else its role's. This is what makes the graph editable: `quimby sync` re-resolves it and applies
 * it onto agent state, so adding or removing an edge in `quimby.yaml` reaches an existing agent
 * without a rebuild (see `applyAgentCoordinationEdges`).
 *
 * The return distinguishes "config declares this agent" from "config says nothing":
 * - an object (possibly empty) ⇒ config is authoritative, so an omitted edge CLEARS the stored one
 * - `null` ⇒ nothing in config names this agent or gives its role edges, so state is left alone
 *   (an agent added outside any preset keeps hand-set edges).
 */
export function resolveConfiguredAgentEdges(
  config: Readonly<QuimbyConfig>,
  agent: Readonly<Pick<AgentState, 'name' | 'role'>>,
): AgentCoordinationEdges | null {
  const entry = findConfiguredAgent(config, agent.name)
  const role = config.roles?.[entry?.role ?? agent.role ?? '']
  if (!entry && !role?.directs?.length && !role?.escalatesTo) return null

  const directs = entry?.directs ?? role?.directs
  const escalatesTo = entry?.escalatesTo ?? role?.escalatesTo
  return {
    ...(directs?.length ? { directs: [...directs] } : {}),
    ...(escalatesTo ? { escalatesTo } : {}),
  }
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

// The config entry declaring an agent: an exact `presets.*.agents.<name>`, else the `count:`-
// expanded entry a replica came from (`builder-2` → `builder`), mirroring `replicaNames`. A string
// entry is the role shorthand, which carries no edges of its own.
function findConfiguredAgent(
  config: Readonly<QuimbyConfig>,
  name: string,
): ConfiguredAgent | undefined {
  const replica = /^(.+)-(\d+)$/.exec(name)
  let fromReplica: ConfiguredAgent | undefined
  for (const preset of Object.values(config.presets ?? {})) {
    const agents = preset.agents ?? {}
    if (Object.hasOwn(agents, name)) return normalizeConfiguredAgent(agents[name])
    if (!replica || fromReplica) continue
    const base = Object.hasOwn(agents, replica[1])
      ? normalizeConfiguredAgent(agents[replica[1]])
      : undefined
    if (base?.count && base.count >= Number(replica[2])) fromReplica = base
  }
  return fromReplica
}

function normalizeConfiguredAgent(
  agent: Readonly<ConfiguredAgent | string | undefined>,
): ConfiguredAgent | undefined {
  if (agent === undefined) return {}
  return typeof agent === 'string' ? { role: agent } : agent
}
