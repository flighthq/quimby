import type { AgentLocation } from './AgentLocation'

export interface CheckConfig {
  command?: string
  verifyByDefault?: boolean
}

export interface AgentRoleConfig {
  runtimeProfile?: string
  runtime?: string
  entrypoint?: string
  check?: string | CheckConfig
  verifyByDefault?: boolean
  syncRef?: string
  tmux?: boolean
}

export interface ConfiguredAgent {
  role?: string
  runtimeProfile?: string
  runtime?: string
  entrypoint?: string
  check?: string | CheckConfig
  verifyByDefault?: boolean
  syncRef?: string
  tmux?: boolean
  hostAlias?: string
  location?: AgentLocation
}

export interface LayoutConfig {
  expr: string
}

export interface RecipeConfig {
  agents?: Record<string, ConfiguredAgent | string>
  subscriptions?: Record<string, string[]>
  layout?: string | LayoutConfig
}

export interface HostAliasConfig {
  type?: 'ssh'
  /**
   * The concrete connection target ("user@host"). Optional so a tracked
   * `quimby.yaml` can *declare* an alias without committing a private address —
   * the binding is filled in per-machine from ignored local/user config (or an
   * interactive prompt at first use). An alias whose `host` is absent, empty, or
   * equal to its own name is treated as unbound.
   */
  host?: string
  port?: number
  base?: string
}

export interface OllamaRuntimeConfig {
  host?: string
  model?: string
}

export interface RuntimeProfileConfig {
  runtime?: string
  entrypoint?: string
  /** Extra argv appended to the entrypoint when no per-run --cmd override is used. */
  args?: string[]
  env?: Record<string, string>
  requiredTools?: string[]
  provider?: string
  model?: string
  ollama?: OllamaRuntimeConfig
  permissions?:
    | string
    | {
        mode?: string
        allow?: string[]
      }
}

export interface QuimbyConfig {
  defaults?: AgentRoleConfig
  roles?: Record<string, AgentRoleConfig>
  runtimeProfiles?: Record<string, RuntimeProfileConfig>
  layouts?: Record<string, string | LayoutConfig>
  recipes?: Record<string, RecipeConfig>
  hosts?: Record<string, HostAliasConfig>
}
