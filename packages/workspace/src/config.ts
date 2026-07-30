import { QuimbyError } from '@quimbyhq/errors'
import { getLocalConfigPath, getProjectConfigPath, getUserConfigDir } from '@quimbyhq/paths'
import type {
  AgentRoleConfig,
  CheckConfig,
  ConfiguredAgent,
  HostAliasConfig,
  NudgePolicy,
  PresetConfig,
  QuimbyConfig,
  RuntimeProfileConfig,
  SSHLocation,
} from '@quimbyhq/types'
import { ensureDir, exists, readYaml, writeYaml } from '@quimbyhq/utils'
import { dirname, join } from 'pathe'

/** A concrete SSH binding — the address an alias resolves to. */
export interface HostAliasBinding {
  host: string
  port?: number
  base?: string
}

/**
 * The result of resolving a stored SSH location against layered config: either a
 * connection-ready location (`host` bound) or the name of an alias still needing a
 * binding. The CLI prompts for and persists the binding when it is unbound.
 */
export type SSHConnectionResolution =
  | { location: SSHLocation & { host: string }; unboundAlias?: undefined }
  | { location?: undefined; unboundAlias: string; port?: number; base?: string }

export function getUserConfigPath(): string {
  return join(getUserConfigDir(), 'config.yaml')
}

export async function loadQuimbyConfig(repoRoot: string): Promise<QuimbyConfig> {
  const [project, user, local] = await Promise.all([
    readOptionalConfig(getProjectConfigPath(repoRoot)),
    readOptionalConfig(getUserConfigPath()),
    readOptionalConfig(getLocalConfigPath(repoRoot)),
  ])
  const merged = mergeConfigs(user, local, project)
  const hosts = mergeHostMaps(project?.hosts, user?.hosts, local?.hosts)
  if (hosts) merged.hosts = hosts
  else delete merged.hosts
  return merged
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
    runtimeProfile: resolved.runtimeProfile,
    runtime: resolved.runtime,
    entrypoint: resolved.entrypoint,
    check: resolved.check,
    verifyByDefault: resolved.verifyByDefault,
    syncRef: resolved.syncRef,
    tmux: resolved.tmux,
    hostAlias: resolved.hostAlias,
  })
}

export function resolveLayoutExpr(config: Readonly<QuimbyConfig>, nameOrExpr: string): string {
  const layout = config.layouts?.[nameOrExpr]
  if (!layout) return nameOrExpr
  return typeof layout === 'string' ? layout : layout.expr
}

export function resolvePreset(config: Readonly<QuimbyConfig>, name: string): PresetConfig {
  const preset = config.presets?.[name]
  if (!preset) throw new QuimbyError(`Preset "${name}" not found in quimby config`)
  return preset
}

export function resolvePresetLayout(config: Readonly<QuimbyConfig>, name: string): string {
  const preset = resolvePreset(config, name)
  if (!preset.layout) throw new QuimbyError(`Preset "${name}" has no layout`)
  // An object `layout: { expr: … }` is an inline expression; a *string* is a reference to a
  // layout defined under `layouts:`. A bare string that names no defined layout is a config
  // typo — fail loudly here rather than let `resolveLayoutExpr` pass it through as a literal
  // expression, which downstream reads as an (unknown) agent name ("agent <x> not found").
  if (typeof preset.layout !== 'string') return preset.layout.expr
  if (!config.layouts?.[preset.layout]) {
    const known = Object.keys(config.layouts ?? {})
    throw new QuimbyError(
      `Preset "${name}" references layout "${preset.layout}", which is not defined under \`layouts:\`` +
        `${known.length ? ` (defined: ${known.join(', ')})` : ' (no layouts are defined)'}. ` +
        'Define it under `layouts:`, or inline an expression with `layout: { expr: "…" }`.',
    )
  }
  return resolveLayoutExpr(config, preset.layout)
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

/**
 * Whether an alias declaration carries a real address. A declaration with no
 * `host`, an empty `host`, or a `host` equal to its own name (the self-referential
 * placeholder a tracked `quimby.yaml` uses to declare an alias without leaking an
 * address) is unbound — it needs a private binding before it can connect.
 */
export function isHostAliasBound(
  alias: Readonly<HostAliasConfig> | undefined,
  name: string,
): boolean {
  return Boolean(alias?.host && alias.host !== name)
}

/**
 * The concrete binding for an alias name across the layered config, or null when
 * it is declared-but-unbound (or undeclared). Host aliases are merged with
 * private local/user bindings over tracked declarations, so a private binding
 * transparently wins here.
 */
export function resolveBoundHostAlias(
  config: Readonly<QuimbyConfig>,
  name: string,
): HostAliasBinding | null {
  const alias = config.hosts?.[name]
  if (!isHostAliasBound(alias, name)) return null
  return {
    host: alias!.host!,
    ...(alias!.port ? { port: alias!.port } : {}),
    ...(alias!.base ? { base: alias!.base } : {}),
  }
}

/**
 * Resolve a stored SSH location against layered config. An explicit `alias` — or a
 * legacy `host` that is really a declared alias name — is bound to its private
 * address; a location that already carries a concrete host passes through. When the
 * alias has no binding yet, the name is returned for the CLI to prompt on.
 */
export function resolveSSHConnection(
  config: Readonly<QuimbyConfig>,
  loc: Readonly<SSHLocation>,
): SSHConnectionResolution {
  const name = loc.alias ?? (loc.host && config.hosts?.[loc.host] ? loc.host : undefined)
  if (!name) {
    if (!loc.host) throw new QuimbyError('SSH location has neither a host nor an alias.')
    return { location: { ...loc, host: loc.host } }
  }
  const bound = resolveBoundHostAlias(config, name)
  if (!bound) {
    return {
      unboundAlias: name,
      ...(loc.port ? { port: loc.port } : {}),
      ...(loc.base ? { base: loc.base } : {}),
    }
  }
  const port = loc.port ?? bound.port
  const base = loc.base ?? bound.base
  return {
    location: {
      type: 'ssh',
      host: bound.host,
      alias: name,
      ...(port ? { port } : {}),
      ...(base ? { base } : {}),
    },
  }
}

/**
 * Persist a host-alias binding to ignored config so the address never touches the
 * tracked repo: `.quimby/local.yaml` for this project (default) or the user config
 * for every project (`global`). Existing config content is preserved. Returns the
 * file written, for the caller to report.
 */
export async function saveHostAliasBinding(
  repoRoot: string,
  name: string,
  binding: Readonly<HostAliasBinding>,
  opts: Readonly<{ global?: boolean }> = {},
): Promise<string> {
  const path = opts.global ? getUserConfigPath() : getLocalConfigPath(repoRoot)
  const existing: QuimbyConfig = (await exists(path)) ? await readYaml<QuimbyConfig>(path) : {}
  existing.hosts = {
    ...(existing.hosts ?? {}),
    [name]: {
      type: 'ssh',
      host: binding.host,
      ...(binding.port ? { port: binding.port } : {}),
      ...(binding.base ? { base: binding.base } : {}),
    },
  }
  await ensureDir(dirname(path))
  await writeYaml(path, existing)
  return path
}

/**
 * Persist the default preset (the one bare `quimby run` opens) to ignored config:
 * `.quimby/local.yaml` for this project (default) or user config (`global`).
 * Existing config content is preserved. Returns the file written.
 */
export async function saveDefaultPreset(
  repoRoot: string,
  name: string,
  opts: Readonly<{ global?: boolean }> = {},
): Promise<string> {
  const path = opts.global ? getUserConfigPath() : getLocalConfigPath(repoRoot)
  const existing: QuimbyConfig = (await exists(path)) ? await readYaml<QuimbyConfig>(path) : {}
  existing.default = name
  await ensureDir(dirname(path))
  await writeYaml(path, existing)
  return path
}

/**
 * Persist the default merge mode (used by a bare `quimby merge`) to ignored config:
 * `.quimby/local.yaml` for this project (default) or user config (`global`), mirroring
 * git's per-repo / global config model. Existing config content is preserved. Returns
 * the file written.
 */
export async function saveMergeModeDefault(
  repoRoot: string,
  mode: QuimbyConfig['mergeMode'],
  opts: Readonly<{ global?: boolean }> = {},
): Promise<string> {
  const path = opts.global ? getUserConfigPath() : getLocalConfigPath(repoRoot)
  const existing: QuimbyConfig = (await exists(path)) ? await readYaml<QuimbyConfig>(path) : {}
  existing.mergeMode = mode
  await ensureDir(dirname(path))
  await writeYaml(path, existing)
  return path
}

/**
 * Which parcels wake an agent (coordination-proposals §6a): the recipient's own `nudge` setting if
 * it has one, else the workspace default, else `directed`. The RECIPIENT governs — this is its
 * tolerance for interruption. `always`/`focus` are accepted as legacy spellings of `all`/`directed`;
 * an unrecognized value falls back to the default rather than failing a courier run over a typo.
 */
/**
 * Advisory warnings about config keys quimby will ignore — a misplaced or misspelled key in
 * `quimby.yaml` is otherwise **silent**, which reads as "quimby is broken" rather than "that key
 * isn't a thing here". (`nudge` is the one that bites: it is a top-level policy, but it looks like
 * it should sit on an agent.) Never fatal, and never a schema check — only keys we know are wrong.
 */
export function collectConfigWarnings(config: Readonly<QuimbyConfig>): string[] {
  const warnings: string[] = []
  // `defaults` was the one container nothing validated, so a key it doesn't read (the reported
  // case: `hostAlias`, before it was one) was ignored in total silence — the config looked like
  // it placed a whole fleet remotely while every agent was created on the local machine.
  for (const key of Object.keys(config.defaults ?? {})) {
    if (AGENT_ROLE_KEYS.has(key)) continue
    warnings.push(
      `defaults.${key} is not an agent setting — ignored. ` +
        `Valid keys: ${[...AGENT_ROLE_KEYS].sort().join(', ')}.`,
    )
  }
  for (const [presetName, preset] of Object.entries(config.presets ?? {})) {
    for (const [agentName, entry] of Object.entries(preset.agents ?? {})) {
      if (typeof entry !== 'object' || entry === null) continue
      for (const key of Object.keys(entry)) {
        if (CONFIGURED_AGENT_KEYS.has(key)) continue
        warnings.push(
          `presets.${presetName}.agents.${agentName}.${key} is not an agent setting — ignored.` +
            (key === 'nudge'
              ? ' Did you mean the top-level `nudge`? (all | directed | never)'
              : ` Valid keys: ${[...CONFIGURED_AGENT_KEYS].sort().join(', ')}.`),
        )
      }
    }
  }
  for (const [name, value] of nudgeSettings(config)) {
    if (typeof value === 'string' && !normalizeNudgePolicy(value)) {
      warnings.push(
        `${name}: "${value}" is not a nudge policy — ignored (falls back to the default). ` +
          'Valid: all | directed | never.',
      )
    }
  }
  for (const [roleName, role] of Object.entries(config.roles ?? {})) {
    for (const key of Object.keys(role ?? {})) {
      if (AGENT_ROLE_KEYS.has(key)) continue
      warnings.push(
        `roles.${roleName}.${key} is not a role setting — ignored.` +
          (key === 'nudge'
            ? ' `nudge` is valid on a role or top-level (all | directed | never).'
            : ''),
      )
    }
  }
  return warnings
}

/**
 * The standing charter for an agent — its own `instructions`, else its role's. Rendered into the
 * generated `CLAUDE.md`/`AGENTS.md` on every launch and `quimby sync`, so a fleet's division of
 * labour lives in tracked config rather than in each agent's overwritable `assignment.md`.
 */
export function resolveAgentInstructions(
  config: Readonly<QuimbyConfig>,
  agent: Readonly<{ name: string; role?: string }>,
): string | undefined {
  for (const preset of Object.values(config.presets ?? {})) {
    const entry = preset.agents?.[agent.name]
    if (typeof entry === 'object' && entry?.instructions) return entry.instructions
  }
  return config.roles?.[agent.role ?? '']?.instructions
}

export function resolveNudgePolicy(
  config: Readonly<QuimbyConfig>,
  agent?: Readonly<{ nudge?: string }>,
): NudgePolicy {
  return normalizeNudgePolicy(agent?.nudge) ?? normalizeNudgePolicy(config.nudge) ?? 'directed'
}

/**
 * A `nudge` value in canonical form, or undefined when it names nothing. Exported because the value
 * is read in two places — the workspace default here, and an agent's own stored setting at dispatch
 * — and normalizing in only one of them is how `nudge: always` came to be honored for the fleet but
 * silently ignored per agent.
 */
export function normalizeNudgePolicy(value: string | undefined): NudgePolicy | undefined {
  if (value === 'all' || value === 'always') return 'all'
  if (value === 'directed' || value === 'focus') return 'directed'
  if (value === 'never') return 'never'
  return undefined
}

export function normalizeCheck(check: string | CheckConfig | undefined): CheckConfig | undefined {
  if (check === undefined) return undefined
  return typeof check === 'string' ? { command: check } : check
}

export function mergeConfigs(...configs: readonly (QuimbyConfig | undefined)[]): QuimbyConfig {
  const out: QuimbyConfig = {}
  for (const config of configs) {
    if (!config) continue
    out.defaults = mergeRole(out.defaults, config.defaults)
    out.roles = { ...(out.roles ?? {}), ...(config.roles ?? {}) }
    out.runtimeProfiles = mergeRuntimeProfileMap(out.runtimeProfiles, config.runtimeProfiles)
    out.layouts = { ...(out.layouts ?? {}), ...(config.layouts ?? {}) }
    // Legacy `recipes` folds into `presets` (presets wins on a name clash) so old configs keep working.
    out.presets = {
      ...(out.presets ?? {}),
      ...(config.recipes ?? {}),
      ...(config.presets ?? {}),
    }
    out.hosts = mergeHostMaps(out.hosts, config.hosts)
    out.services = { ...(out.services ?? {}), ...(config.services ?? {}) }
    if (config.default !== undefined) out.default = config.default
    if (config.mergeMode !== undefined) out.mergeMode = config.mergeMode
    // Per-key so a project can set a ceiling while user config keeps the reap threshold.
    if (config.pool) out.pool = { ...(out.pool ?? {}), ...defined(config.pool) }
    if (config.nudge !== undefined) out.nudge = config.nudge
  }
  return out
}

function mergeHostMaps(
  ...maps: readonly (Record<string, HostAliasConfig> | undefined)[]
): Record<string, HostAliasConfig> | undefined {
  const out: Record<string, HostAliasConfig> = {}
  for (const map of maps) {
    for (const [name, host] of Object.entries(map ?? {})) {
      out[name] = { ...(out[name] ?? {}), ...defined(host) }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function mergeRuntimeProfileMap(
  base: Record<string, RuntimeProfileConfig> | undefined,
  override: Record<string, RuntimeProfileConfig> | undefined,
): Record<string, RuntimeProfileConfig> | undefined {
  if (!base && !override) return undefined
  const out = { ...(base ?? {}) }
  for (const [name, profile] of Object.entries(override ?? {})) {
    out[name] = mergeRuntimeProfile(out[name], profile)
  }
  return out
}

function mergeRuntimeProfile(
  base: RuntimeProfileConfig | undefined,
  override: RuntimeProfileConfig | undefined,
): RuntimeProfileConfig {
  const merged: RuntimeProfileConfig = { ...(base ?? {}), ...defined(override) }
  // Only attach the deep-merged sub-objects when they carry something. An empty
  // `ollama: {}` in particular is not inert: `isOllamaProfile` treats a *defined*
  // `ollama` as "this is an Ollama profile", which would spuriously add `ollama` to
  // every profile's required tools. Same reasoning keeps an empty `env`/`permissions`
  // off the result rather than fabricating keys the source configs never set.
  const env = { ...(base?.env ?? {}), ...(override?.env ?? {}) }
  if (Object.keys(env).length > 0) merged.env = env
  else delete merged.env

  const ollama = { ...(base?.ollama ?? {}), ...(override?.ollama ?? {}) }
  if (Object.keys(ollama).length > 0) merged.ollama = ollama
  else delete merged.ollama

  const permissions = mergePermissions(base?.permissions, override?.permissions)
  if (permissions !== undefined) merged.permissions = permissions
  else delete merged.permissions

  return merged
}

function mergePermissions(
  base: RuntimeProfileConfig['permissions'],
  override: RuntimeProfileConfig['permissions'],
): RuntimeProfileConfig['permissions'] {
  if (override === undefined) return base
  if (typeof override === 'string' || typeof base === 'string') return override
  return {
    ...(base ?? {}),
    ...override,
    allow: override.allow ?? base?.allow,
  }
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

// The keys each config container actually reads. Kept beside the interfaces they mirror; a new
// field must be added here too, or `collectConfigWarnings` will report it as unknown.
const AGENT_ROLE_KEYS = new Set([
  'instructions',
  'nudge',
  'runtimeProfile',
  'runtime',
  'entrypoint',
  'check',
  'verifyByDefault',
  'syncRef',
  'tmux',
  'hostAlias',
  'directs',
  'escalatesTo',
])

const CONFIGURED_AGENT_KEYS = new Set([
  ...AGENT_ROLE_KEYS,
  'role',
  'hostAlias',
  'location',
  'count',
])

// Every place a `nudge` policy can be declared, labelled for the warning.
function nudgeSettings(config: Readonly<QuimbyConfig>): [string, unknown][] {
  const out: [string, unknown][] = []
  if (config.nudge !== undefined) out.push(['nudge', config.nudge])
  for (const [role, cfg] of Object.entries(config.roles ?? {})) {
    if (cfg?.nudge !== undefined) out.push([`roles.${role}.nudge`, cfg.nudge])
  }
  for (const [preset, cfg] of Object.entries(config.presets ?? {})) {
    for (const [agent, entry] of Object.entries(cfg.agents ?? {})) {
      if (typeof entry === 'object' && entry !== null && entry.nudge !== undefined) {
        out.push([`presets.${preset}.agents.${agent}.nudge`, entry.nudge])
      }
    }
  }
  return out
}
