import { QuimbyError } from '@quimbyhq/errors'
import { runtimeTypes } from '@quimbyhq/runtimes'
import type { AgentState, RuntimeType } from '@quimbyhq/types'

export interface RuntimeSelection {
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
  cmd?: string
  runtime?: string
}): RuntimeSelection {
  const saved = opts.agent.defaults
  const runtime =
    (opts.runtime as RuntimeType | undefined) ?? (saved?.runtime as RuntimeType) ?? 'local'
  const entrypoint = opts.cmd ?? saved?.entrypoint ?? 'claude'

  if (!runtimeTypes.includes(runtime)) {
    throw new QuimbyError(`Unknown runtime "${runtime}". Available: ${runtimeTypes.join(', ')}`)
  }

  return { runtime, entrypoint, runtimeLabel: runtime !== 'local' ? ` [${runtime}]` : '' }
}
