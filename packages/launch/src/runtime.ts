import {
  resolveRuntimeSelection as resolveProfileRuntimeSelection,
  type RuntimeSelection as ProfileRuntimeSelection,
} from '@quimbyhq/runtime-profile'
import type { AgentState, QuimbyConfig, RuntimeType } from '@quimbyhq/types'

export interface RuntimeSelection extends ProfileRuntimeSelection {
  runtime: RuntimeType
  entrypoint: string
  /** A ` [runtime]` suffix for logs when the runtime is non-default, else empty. */
  runtimeLabel: string
}

/**
 * Resolve the runtime and entrypoint for a launch: an explicit override wins, then the
 * agent's saved defaults, then the built-ins (`local` / `claude`). Throws on an unknown
 * runtime so a typo fails before any tmux/SSH work begins.
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
    saved: opts.agent.defaults,
    runtimeProfile: opts.runtimeProfile,
    runtime: opts.runtime,
    cmd: opts.cmd,
  })
}
