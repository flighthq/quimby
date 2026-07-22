import {
  resolveRuntimeSelection as resolveProfileRuntimeSelection,
  type RuntimeSelection as ProfileRuntimeSelection,
} from '@quimbyhq/runtime-profile'
import type {
  AgentDefaults,
  AgentState,
  ConfiguredAgent,
  QuimbyConfig,
  RuntimeType,
} from '@quimbyhq/types'
import { resolveAgentRoleConfig, resolveConfiguredAgent } from '@quimbyhq/workspace'

export interface RuntimeSelection extends ProfileRuntimeSelection {
  runtime: RuntimeType
  entrypoint: string
  /** A ` [runtime]` suffix for logs when the runtime is non-default, else empty. */
  runtimeLabel: string
}

/**
 * Resolve the runtime and entrypoint for a launch: an explicit override wins, then — for an
 * agent that records a `role` — the role's launch config resolved *fresh from current config*
 * (so a profile/role edit, including a rename, propagates), then the agent's stored flattened
 * defaults, then the built-ins (`local` / `claude`). Throws on an unknown runtime so a typo
 * fails before any tmux/SSH work begins.
 */
export function resolveRuntimeSelection(opts: {
  agent: Readonly<AgentState>
  config?: Readonly<QuimbyConfig>
  cmd?: string
  runtime?: string
  runtimeProfile?: string
}): RuntimeSelection {
  return resolveProfileRuntimeSelection({
    config: opts.config,
    saved: resolveAgentLaunchDefaults(opts.agent, opts.config),
    runtimeProfile: opts.runtimeProfile,
    runtime: opts.runtime,
    cmd: opts.cmd,
  })
}

/** A stable fingerprint of the resolved launch command, for drift detection (see `AgentState.launchedWith`). */
export function launchFingerprint(
  selection: Readonly<Pick<RuntimeSelection, 'runtime' | 'entrypoint'>>,
): string {
  return `${selection.runtime} ${selection.entrypoint}`
}

/**
 * The launch defaults for an agent, config-fresh: an agent named in a preset resolves from that
 * tracked per-agent entry, an agent that records a `role` resolves through the current role, and
 * older state may still pick up a same-named role. Tracked defaults participate through those
 * preset/role resolutions. This lets edits/renames propagate and keeps tracked launch intent
 * ahead of stale stored defaults. A deleted role degrades to last-known config, not a failure.
 */
export function resolveAgentLaunchDefaults(
  agent: Readonly<AgentState>,
  config: Readonly<QuimbyConfig> | undefined,
): AgentDefaults | undefined {
  const presetAgent = resolvePresetAgentLaunchDefaults(config, agent.name)
  if (presetAgent) return applyProfilePin(presetAgent, agent.runtimeProfile)

  const roleName = agent.role ?? agent.name
  if (config?.roles?.[roleName]) {
    try {
      return applyProfilePin(
        launchDefaultsFromRole(resolveAgentRoleConfig(config, { role: roleName })),
        agent.runtimeProfile,
      )
    } catch {
      // Role no longer in config — fall through to the agent's stored defaults.
    }
  }
  return applyProfilePin(agent.defaults, agent.runtimeProfile)
}

/**
 * A deliberate per-instance profile pin (`AgentState.runtimeProfile`) overrides the role/preset
 * engine entirely: the pinned profile determines runtime + entrypoint at launch, so the role's
 * own engine (and any raw runtime/entrypoint it carried) is dropped. This is what lets a
 * `--profile codex` +1 of a Claude `builder` role actually run Codex. No pin ⇒ base unchanged.
 */
function applyProfilePin(
  base: AgentDefaults | undefined,
  pin: string | undefined,
): AgentDefaults | undefined {
  if (!pin) return base
  return { runtimeProfile: pin }
}

function resolvePresetAgentLaunchDefaults(
  config: Readonly<QuimbyConfig> | undefined,
  name: string,
): AgentDefaults | undefined {
  const raw = findPresetAgent(config, name)
  if (!raw.found) return undefined
  try {
    return launchDefaultsFromRole(
      resolveAgentRoleConfig(config!, resolveConfiguredAgent(config!, raw.agent)),
    )
  } catch {
    return undefined
  }
}

function findPresetAgent(
  config: Readonly<QuimbyConfig> | undefined,
  name: string,
): { found: false } | { found: true; agent: ConfiguredAgent | string | undefined } {
  if (!config?.presets) return { found: false }
  const presetNames = [
    ...(config.default ? [config.default] : []),
    ...Object.keys(config.presets).filter((preset) => preset !== config.default),
  ]
  for (const presetName of presetNames) {
    const agents = config.presets[presetName]?.agents
    if (agents && Object.prototype.hasOwnProperty.call(agents, name)) {
      return { found: true, agent: agents[name] }
    }
  }
  return { found: false }
}

function launchDefaultsFromRole(role: {
  runtimeProfile?: string
  runtime?: string
  entrypoint?: string
}): AgentDefaults | undefined {
  if (!role.runtimeProfile && !role.runtime && !role.entrypoint) return undefined
  return {
    ...(role.runtimeProfile ? { runtimeProfile: role.runtimeProfile } : {}),
    ...(role.runtime ? { runtime: role.runtime } : {}),
    ...(role.entrypoint ? { entrypoint: role.entrypoint } : {}),
  }
}
