import { addAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import type { ConfiguredAgent, QuimbyConfig, QuimbyState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import {
  loadState,
  normalizeCheck,
  resolveAgentRoleConfig,
  resolveConfiguredAgent,
  resolveHostAlias,
  resolvePreset,
  resolvePresetLayout,
} from '@quimbyhq/workspace'

import { collectLayoutAgents, isRoleToken, isServiceToken, parseLayout, roleNameOf } from './layout'

type PresetAgentConfig = ConfiguredAgent | string | undefined

export async function createMissingPresetAgents(
  repoRoot: string,
  config: Readonly<QuimbyConfig>,
  presetName: string,
): Promise<void> {
  const agents = resolvePresetAgentEntries(config, presetName)
  // The layout places agents; it never creates them. A leaf naming neither a configured entry
  // nor a live agent is reported here — before anything is created — so a stale layout says so
  // instead of silently resurrecting an agent you removed.
  assertPresetLayoutSatisfied(config, presetName, await loadState(repoRoot), agents)

  for (const [name, rawAgent] of agents) {
    const state = await loadState(repoRoot)
    if (state.agents[name]) {
      logger.info(`Agent "${name}" already exists`)
      continue
    }
    const configured = resolveConfiguredAgent(config, rawAgent)
    const role = resolveAgentRoleConfig(config, configured)
    const check = normalizeCheck(role.check)
    if (configured.hostAlias) resolveHostAlias(config, configured.hostAlias)
    const location =
      configured.location ??
      (configured.hostAlias ? { type: 'ssh' as const, alias: configured.hostAlias } : undefined)
    await addAgent(repoRoot, name, {
      ...(configured.role ? { role: configured.role } : {}),
      // An explicit profile override on the entry is stored as the per-instance pin, so a replica
      // (not a named preset entry, so not found by name at launch) keeps its engine over the role.
      ...(configured.runtimeProfile ? { runtimeProfile: configured.runtimeProfile } : {}),
      defaults:
        role.runtimeProfile || role.runtime || role.entrypoint
          ? {
              ...(role.runtimeProfile ? { runtimeProfile: role.runtimeProfile } : {}),
              runtime: role.runtime,
              entrypoint: role.entrypoint,
            }
          : undefined,
      ...(location ? { location } : {}),
      ...(role.syncRef ? { syncRef: role.syncRef } : {}),
      ...(role.tmux ? { tmux: true } : {}),
      ...(check?.command ? { check: check.command } : {}),
      ...((check?.verifyByDefault ?? role.verifyByDefault) ? { verifyByDefault: true } : {}),
    })
    logger.success(`Agent "${name}" created${configured.role ? ` (${configured.role})` : ''}`)
  }
}

// The agents a preset declares — `presets.<name>.agents`, with `count: N` expanded into replicas.
// The preset's layout is deliberately NOT consulted: a layout *places* agents, it does not create
// them (see `assertPresetLayoutSatisfied`), so removing an agent from `agents:` removes it for
// good even while a stale layout still names it.
export function resolvePresetAgentEntries(
  config: Readonly<QuimbyConfig>,
  presetName: string,
): [string, PresetAgentConfig][] {
  const preset = resolvePreset(config, presetName)
  const entries = new Map<string, PresetAgentConfig>()
  for (const [name, rawAgent] of Object.entries(preset.agents ?? {})) {
    for (const [replicaName, replicaConfig] of expandReplicas(name, rawAgent)) {
      entries.set(replicaName, replicaConfig)
    }
  }
  return [...entries.entries()]
}

// Throw when a preset's layout names something nothing can fill: a bare leaf that is neither a
// configured entry nor a live agent, or a `@role` slot with no instance either way. Creation is
// driven by `agents:` alone, so an unsatisfiable leaf is a config mistake to surface — the common
// one being an agent removed from `agents:` (and from the workspace) but left in the layout.
export function assertPresetLayoutSatisfied(
  config: Readonly<QuimbyConfig>,
  presetName: string,
  state: Readonly<QuimbyState>,
  entries: readonly [string, PresetAgentConfig][],
): void {
  const preset = resolvePreset(config, presetName)
  if (!preset.layout) return

  const configured = new Map(entries)
  const has = (name: string): boolean => configured.has(name) || Boolean(state.agents[name])
  const hasRole = (role: string): boolean =>
    [...configured.entries()].some(
      ([name, agent]) => resolveConfiguredAgent(config, agent).role === role || name === role,
    ) || Object.entries(state.agents).some(([name, agent]) => agent.role === role || name === role)

  for (const name of collectLayoutAgents(parseLayout(resolvePresetLayout(config, presetName)))) {
    if (isHostLayoutToken(name) || isServiceToken(name)) continue
    if (isRoleToken(name)) {
      const role = roleNameOf(name)
      if (!config.roles?.[role]) {
        throw new QuimbyError(
          `Preset "${presetName}" layout references role "${name}", but no role "${role}" is defined under \`roles:\`.`,
        )
      }
      if (!hasRole(role)) {
        throw new QuimbyError(
          `Preset "${presetName}" layout places role "${name}", but no agent has role "${role}". ` +
            `Declare one under \`presets.${presetName}.agents\` (e.g. \`${role}: { role: ${role} }\`), ` +
            `add one with \`quimby add <name> --role ${role}\`, or drop "${name}" from the layout.`,
        )
      }
      continue
    }
    if (has(name)) continue
    throw new QuimbyError(
      `Preset "${presetName}" layout places agent "${name}", which does not exist and is not declared under \`presets.${presetName}.agents\`. ` +
        `A layout only places agents — it never creates them — so either declare "${name}" under \`agents:\`, ` +
        `create it with \`quimby add ${name}\`, or remove it from the layout.`,
    )
  }
}

export function isHostLayoutToken(name: string): boolean {
  return name === 'host' || name === '$'
}

// The replica names for a `count: N` entry: `<base>`, `<base>-2`, … `<base>-N`. count ≤ 1 is the
// bare base. Deterministic (not "next free"), so `up` fills exactly this set and reconciles idempotently.
export function replicaNames(base: string, count: number): string[] {
  const n = Math.max(1, Math.floor(count))
  return Array.from({ length: n }, (_, i) => (i === 0 ? base : `${base}-${i + 1}`))
}

// A preset entry with `count: N` becomes N replica entries (config minus the count); anything else
// is a single entry. The count lives on the entry, not each replica, so the replicas share config.
function expandReplicas(name: string, rawAgent: PresetAgentConfig): [string, PresetAgentConfig][] {
  if (typeof rawAgent !== 'object' || rawAgent === null || !rawAgent.count || rawAgent.count <= 1) {
    return [[name, rawAgent]]
  }
  const rest: ConfiguredAgent = { ...rawAgent }
  delete rest.count
  return replicaNames(name, rawAgent.count).map((replicaName) => [replicaName, rest])
}
