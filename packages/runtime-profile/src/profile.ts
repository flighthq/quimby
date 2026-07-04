import { QuimbyError } from '@quimbyhq/errors'
import { runtimeCli, runtimeTypes } from '@quimbyhq/runtimes'
import type {
  AgentDefaults,
  QuimbyConfig,
  RuntimeProfileConfig,
  RuntimeType,
} from '@quimbyhq/types'

export const DEFAULT_RUNTIME: RuntimeType = 'local'
export const DEFAULT_ENTRYPOINT = 'claude'

export interface RuntimeSelection {
  runtime: RuntimeType
  entrypoint: string
  env: Record<string, string>
  requiredTools: string[]
  runtimeLabel: string
  profileName?: string
  profile?: RuntimeProfileConfig
}

export interface RuntimeSelectionOptions {
  config?: Readonly<QuimbyConfig>
  saved?: Readonly<AgentDefaults>
  runtimeProfile?: string
  runtime?: string
  cmd?: string
}

export function resolveRuntimeProfile(
  config: Readonly<QuimbyConfig> | undefined,
  name: string | undefined,
): RuntimeProfileConfig | undefined {
  if (!name) return undefined
  const profile = config?.runtimeProfiles?.[name]
  if (!profile) throw new QuimbyError(`Runtime profile "${name}" not found in quimby config`)
  return profile
}

export function resolveRuntimeSelection(opts: RuntimeSelectionOptions = {}): RuntimeSelection {
  const profileName = opts.runtimeProfile ?? opts.saved?.runtimeProfile
  const profile = resolveRuntimeProfile(opts.config, profileName)
  const saved = opts.runtimeProfile ? undefined : opts.saved
  const runtime = resolveRuntime(opts.runtime ?? saved?.runtime ?? profile?.runtime)
  const entrypoint = resolveEntrypoint({
    cmd: opts.cmd,
    saved: saved?.entrypoint,
    profile,
  })
  const env = resolveRuntimeEnv(profile)
  const requiredTools = resolveRuntimeRequirements({ runtime, entrypoint, profile })
  return {
    runtime,
    entrypoint,
    env,
    requiredTools,
    runtimeLabel: runtime !== DEFAULT_RUNTIME ? ` [${runtime}]` : '',
    ...(profileName ? { profileName } : {}),
    ...(profile ? { profile } : {}),
  }
}

export function resolveRuntimeEnv(
  profile: Readonly<RuntimeProfileConfig> | undefined,
): Record<string, string> {
  const env = { ...(profile?.env ?? {}) }
  if (isOllamaProfile(profile) && profile?.ollama?.host) {
    env.OLLAMA_HOST = profile.ollama.host
  }
  return env
}

export function resolveRuntimeRequirements(opts: {
  runtime: RuntimeType
  entrypoint?: string
  profile?: Readonly<RuntimeProfileConfig>
}): string[] {
  return unique([
    runtimeCli(opts.runtime),
    ...providerTools(opts.profile),
    ...(opts.profile?.requiredTools ?? []),
  ])
}

function resolveRuntime(value: string | undefined): RuntimeType {
  const runtime = (value ?? DEFAULT_RUNTIME) as RuntimeType
  if (!runtimeTypes.includes(runtime)) {
    throw new QuimbyError(`Unknown runtime "${runtime}". Available: ${runtimeTypes.join(', ')}`)
  }
  return runtime
}

function resolveEntrypoint(opts: {
  cmd?: string
  saved?: string
  profile?: Readonly<RuntimeProfileConfig>
}): string {
  if (opts.cmd) return opts.cmd
  const base = opts.saved ?? opts.profile?.entrypoint ?? DEFAULT_ENTRYPOINT
  const args = opts.profile?.args ?? []
  return args.length > 0 ? [base, ...args.map(shellArg)].join(' ') : base
}

function providerTools(profile: Readonly<RuntimeProfileConfig> | undefined): string[] {
  return isOllamaProfile(profile) ? ['ollama'] : []
}

function isOllamaProfile(profile: Readonly<RuntimeProfileConfig> | undefined): boolean {
  return profile?.provider === 'ollama' || profile?.ollama !== undefined
}

function shellArg(value: string): string {
  return /^[\w./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`
}

function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}
