import type { AgentLocation } from './AgentLocation'

export interface CheckConfig {
  command?: string
  verifyByDefault?: boolean
}

export interface AgentRoleConfig {
  runtime?: string
  entrypoint?: string
  check?: string | CheckConfig
  verifyByDefault?: boolean
  syncRef?: string
  tmux?: boolean
}

export interface ConfiguredAgent {
  role?: string
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
  host: string
  port?: number
  base?: string
}

export interface QuimbyConfig {
  defaults?: AgentRoleConfig
  roles?: Record<string, AgentRoleConfig>
  layouts?: Record<string, string | LayoutConfig>
  recipes?: Record<string, RecipeConfig>
  hosts?: Record<string, HostAliasConfig>
}
