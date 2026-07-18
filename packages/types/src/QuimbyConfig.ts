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

export interface PresetConfig {
  agents?: Record<string, ConfiguredAgent | string>
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
  presets?: Record<string, PresetConfig>
  /** @deprecated Renamed to `presets`; still read (and folded into `presets`) for back-compat. */
  recipes?: Record<string, PresetConfig>
  hosts?: Record<string, HostAliasConfig>
  /**
   * Named host-side commands a layout can place with a `$name` token (e.g.
   * `server: quimby serve`). The command runs in a dashboard-local pane, so it is
   * torn down when the dashboard exits.
   */
  services?: Record<string, string>
  /** Name of the preset bare `quimby run` opens and bare `quimby up` creates. */
  default?: string
  /**
   * Default mode for a bare `quimby merge` (no `--commits`/`--patch`/`--squashed`). One of
   * "squashed" (the built-in default when unset), "commits", or "patch" — the values match
   * `@quimbyhq/handoff`'s `ApplyMode`. Set per-repo or user-global with
   * `quimby merge <agent> --<mode> --default [--global]`, mirroring the git config model.
   */
  mergeMode?: 'squashed' | 'commits' | 'patch'
}
