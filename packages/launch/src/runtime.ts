import {
  resolveRuntimeSelection as resolveProfileRuntimeSelection,
  type RuntimeSelection as ProfileRuntimeSelection,
} from '@quimbyhq/runtime-profile'
import type { AgentDefaults, AgentState, QuimbyConfig, RuntimeType } from '@quimbyhq/types'
import { resolveAgentRoleConfig } from '@quimbyhq/workspace'

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
 * The launch defaults for an agent, role-fresh: an agent that records a `role` resolves its
 * runtime profile/entrypoint from current config through that role (so edits/renames
 * propagate), falling back to the stored flattened defaults when there is no role, no config,
 * or the role no longer resolves (a deleted role degrades to last-known config, not a failure).
 */
export function resolveAgentLaunchDefaults(
  agent: Readonly<AgentState>,
  config: Readonly<QuimbyConfig> | undefined,
): AgentDefaults | undefined {
  if (agent.role && config) {
    try {
      const role = resolveAgentRoleConfig(config, { role: agent.role })
      return {
        ...(role.runtimeProfile ? { runtimeProfile: role.runtimeProfile } : {}),
        ...(role.runtime ? { runtime: role.runtime } : {}),
        ...(role.entrypoint ? { entrypoint: role.entrypoint } : {}),
      }
    } catch {
      // Role no longer in config — fall through to the agent's stored defaults.
    }
  }
  return agent.defaults
}
