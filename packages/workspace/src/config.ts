import { homedir } from 'node:os'

import { QuimbyError } from '@quimbyhq/errors'
import { getLocalConfigPath, getProjectConfigPath } from '@quimbyhq/paths'
import type {
  AgentRoleConfig,
  CheckConfig,
  ConfiguredAgent,
  HostAliasConfig,
  QuimbyConfig,
  RecipeConfig,
} from '@quimbyhq/types'
import { exists, readYaml } from '@quimbyhq/utils'
import { join } from 'pathe'

export function getUserConfigPath(): string {
  return join(homedir(), '.config', 'quimby', 'config.yaml')
}

export async function loadQuimbyConfig(repoRoot: string): Promise<QuimbyConfig> {
  const [project, user, local] = await Promise.all([
    readOptionalConfig(getProjectConfigPath(repoRoot)),
    readOptionalConfig(getUserConfigPath()),
    readOptionalConfig(getLocalConfigPath(repoRoot)),
  ])
  return mergeConfigs(project, user, local)
}

export function resolveRole(config: Readonly<QuimbyConfig>, role: string): AgentRoleConfig {
  const found = config.roles?.[role]
  if (!found) throw new QuimbyError(`Role "${role}" not found in quimby config`)
  return mergeRole(config.defaults, found)
}

export function resolveConfiguredAgent(
  config: Readonly<QuimbyConfig>,
  agent: Readonly<ConfiguredAgent | string | undefined>,
): ConfiguredAgent {
  if (!agent) return {}
  if (typeof agent === 'string') return { role: agent }
  return agent
}

export function resolveAgentRoleConfig(
  config: Readonly<QuimbyConfig>,
  agent: Readonly<ConfiguredAgent | string | undefined>,
): AgentRoleConfig {
  const resolved = resolveConfiguredAgent(config, agent)
  const role = resolved.role ? resolveRole(config, resolved.role) : (config.defaults ?? {})
  return mergeRole(role, {
    runtime: resolved.runtime,
    entrypoint: resolved.entrypoint,
    check: resolved.check,
    verifyByDefault: resolved.verifyByDefault,
    syncRef: resolved.syncRef,
    tmux: resolved.tmux,
  })
}

export function resolveLayoutExpr(config: Readonly<QuimbyConfig>, nameOrExpr: string): string {
  const layout = config.layouts?.[nameOrExpr]
  if (!layout) return nameOrExpr
  return typeof layout === 'string' ? layout : layout.expr
}

export function resolveRecipe(config: Readonly<QuimbyConfig>, name: string): RecipeConfig {
  const recipe = config.recipes?.[name]
  if (!recipe) throw new QuimbyError(`Recipe "${name}" not found in quimby config`)
  return recipe
}

export function resolveRecipeLayout(config: Readonly<QuimbyConfig>, name: string): string {
  const recipe = resolveRecipe(config, name)
  if (!recipe.layout) throw new QuimbyError(`Recipe "${name}" has no layout`)
  return typeof recipe.layout === 'string'
    ? resolveLayoutExpr(config, recipe.layout)
    : recipe.layout.expr
}

export function resolveHostAlias(
  config: Readonly<QuimbyConfig>,
  alias: string | undefined,
): HostAliasConfig | undefined {
  if (!alias) return undefined
  const host = config.hosts?.[alias]
  if (!host) throw new QuimbyError(`Host alias "${alias}" not found in quimby config`)
  return host
}

export function normalizeCheck(check: string | CheckConfig | undefined): CheckConfig | undefined {
  if (check === undefined) return undefined
  return typeof check === 'string' ? { command: check } : check
}

function mergeConfigs(...configs: readonly (QuimbyConfig | undefined)[]): QuimbyConfig {
  const out: QuimbyConfig = {}
  for (const config of configs) {
    if (!config) continue
    out.defaults = mergeRole(out.defaults, config.defaults)
    out.roles = { ...(out.roles ?? {}), ...(config.roles ?? {}) }
    out.layouts = { ...(out.layouts ?? {}), ...(config.layouts ?? {}) }
    out.recipes = { ...(out.recipes ?? {}), ...(config.recipes ?? {}) }
    out.hosts = { ...(out.hosts ?? {}), ...(config.hosts ?? {}) }
  }
  return out
}

function mergeRole(
  base: AgentRoleConfig | undefined,
  override: AgentRoleConfig | undefined,
): AgentRoleConfig {
  return {
    ...(base ?? {}),
    ...defined(override),
    check: mergeCheck(base?.check, override?.check),
  }
}

function mergeCheck(
  base: string | CheckConfig | undefined,
  override: string | CheckConfig | undefined,
): string | CheckConfig | undefined {
  if (override === undefined) return base
  if (typeof override === 'string' || typeof base === 'string') return override
  return { ...(base ?? {}), ...override }
}

async function readOptionalConfig(path: string): Promise<QuimbyConfig | undefined> {
  if (!(await exists(path))) return undefined
  return (await readYaml<QuimbyConfig>(path)) ?? {}
}

function defined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}
