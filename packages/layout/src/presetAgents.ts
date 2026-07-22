import { addAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import type { ConfiguredAgent, QuimbyConfig } from '@quimbyhq/types'
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

export function resolvePresetAgentEntries(
  config: Readonly<QuimbyConfig>,
  presetName: string,
): [string, PresetAgentConfig][] {
  const preset = resolvePreset(config, presetName)
  const explicit = preset.agents ?? {}
  const entries = new Map<string, PresetAgentConfig>(Object.entries(explicit))
  if (!preset.layout) return [...entries.entries()]

  for (const name of collectLayoutAgents(parseLayout(resolvePresetLayout(config, presetName)))) {
    if (isHostLayoutToken(name) || isServiceToken(name)) continue
    // A `@role` slot expands to *existing* instances at plan time; here at creation it only needs
    // to guarantee at least one exists, so it is satisfied by any explicit agent of that role and
    // otherwise seeds a single `<role>` agent. (Replica counts from a preset are a separate feature.)
    if (isRoleToken(name)) {
      const role = roleNameOf(name)
      if (!config.roles?.[role]) {
        throw new QuimbyError(
          `Preset "${presetName}" layout references role "${name}", but no role "${role}" is defined under \`roles:\`.`,
        )
      }
      const hasInstance = [...entries.values()].some(
        (agent) => resolveConfiguredAgent(config, agent).role === role,
      )
      if (!hasInstance && !entries.has(role)) entries.set(role, { role })
      continue
    }
    if (entries.has(name)) continue
    if (config.roles?.[name]) entries.set(name, { role: name })
    else if (config.defaults) entries.set(name, undefined)
    else {
      throw new QuimbyError(
        `Preset "${presetName}" layout references agent "${name}", but it is not configured under \`presets.${presetName}.agents\` and no role named "${name}" exists.`,
      )
    }
  }
  return [...entries.entries()]
}

export function isHostLayoutToken(name: string): boolean {
  return name === 'host' || name === '$'
}
