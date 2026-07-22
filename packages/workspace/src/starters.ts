import { QuimbyError } from '@quimbyhq/errors'
import { getProjectConfigPath } from '@quimbyhq/paths'
import type { ConfiguredAgent, QuimbyConfig, RuntimeProfileConfig } from '@quimbyhq/types'
import { exists, writeYaml } from '@quimbyhq/utils'

import { resolveBoundHostAlias } from './config'

export type StarterName = 'solo' | 'review-loop' | 'fleet'
export type StarterEngine = 'claude' | 'codex' | 'sbx-claude' | 'sbx-codex'

export interface StarterOptions {
  /** Replica count for the builder slot (review-loop / fleet). Defaults to the starter's own. */
  builderCount?: number
  /** A built-in engine emitted as a runtime profile. Defaults to `claude` (local); ignored if `reuseProfile` is set. */
  engine?: StarterEngine
  /**
   * Reuse a runtime profile the user already has: reference it by name, inlining only its shareable
   * shape into the tracked file (private fills stay in the user's config and merge at resolution).
   */
  reuseProfile?: { name: string; profile: RuntimeProfileConfig }
  /** An existing host alias to reference (declared unbound in the tracked file, bound privately). */
  hostAlias?: string
}

export interface StarterInfo {
  name: StarterName
  description: string
}

export function listStarters(): StarterInfo[] {
  return [
    { name: 'solo', description: 'One local agent — the simplest workspace.' },
    { name: 'review-loop', description: 'A builder and a reviewer with a two-pane dashboard.' },
    { name: 'fleet', description: 'Several builders on a role slot beside a reviewer.' },
  ]
}

/**
 * Build a starter `quimby.yaml` shape (roles, runtime profiles, a preset, a layout, a default). The
 * engine is emitted as a runtime profile referenced by every role; a `hostAlias` is *declared*
 * unbound (its address stays in private config) and referenced by the preset's agents. Pure — the
 * caller writes it with {@link scaffoldQuimbyConfig}.
 */
export function buildStarterConfig(
  name: StarterName,
  opts: Readonly<StarterOptions> = {},
): QuimbyConfig {
  // Reuse a user profile (name + shareable shape) if given, else a built-in engine.
  const engineName = opts.reuseProfile ? opts.reuseProfile.name : (opts.engine ?? 'claude')
  const engineShape = opts.reuseProfile
    ? shareableProfileShape(opts.reuseProfile.profile)
    : ENGINES[opts.engine ?? 'claude']
  const profiles: Record<string, RuntimeProfileConfig> = { [engineName]: engineShape }
  const host = opts.hostAlias
  const hosts = host ? { hosts: { [host]: {} } } : {}
  const agent = (role: string, extra: Readonly<ConfiguredAgent> = {}): ConfiguredAgent => ({
    role,
    ...(host ? { hostAlias: host } : {}),
    ...extra,
  })
  // A fresh object per role — never a shared reference, so the serialized yaml has no anchors/aliases.
  const role = (): { runtimeProfile: string } => ({ runtimeProfile: engineName })

  if (name === 'solo') {
    return {
      ...hosts,
      roles: { dev: role() },
      runtimeProfiles: profiles,
      presets: { solo: { agents: { dev: agent('dev') } } },
      default: 'solo',
    }
  }

  const builderCount = opts.builderCount ?? (name === 'fleet' ? 3 : 1)
  return {
    ...hosts,
    roles: { builder: role(), reviewer: role() },
    runtimeProfiles: profiles,
    layouts: { fleet: '@reviewer | @builder' },
    presets: {
      [name]: {
        agents: {
          builder: agent('builder', builderCount > 1 ? { count: builderCount } : {}),
          reviewer: agent('reviewer'),
        },
        layout: 'fleet',
      },
    },
    default: name,
  }
}

/** Runtime profiles declared in config, for `init` to offer for reuse (name + a display label). */
export function listRuntimeProfiles(
  config: Readonly<QuimbyConfig>,
): { name: string; profile: RuntimeProfileConfig }[] {
  return Object.entries(config.runtimeProfiles ?? {}).map(([name, profile]) => ({ name, profile }))
}

/**
 * The team-safe subset of a runtime profile to inline into a tracked file: the `runtime`/`entrypoint`
 * shape that makes it launchable. The machine/secret fills (`env`, `provider`, `model`, `ollama`,
 * `permissions`, `args`) are deliberately dropped — they stay in the user's private config and merge
 * back at resolution — so `init` reusing a profile never writes a secret into git.
 */
export function shareableProfileShape(
  profile: Readonly<RuntimeProfileConfig>,
): RuntimeProfileConfig {
  return {
    ...(profile.runtime ? { runtime: profile.runtime } : {}),
    ...(profile.entrypoint ? { entrypoint: profile.entrypoint } : {}),
  }
}

/** Host aliases in config that already have a concrete address bound, for `init` to offer for reuse. */
export function listBoundHostAliases(
  config: Readonly<QuimbyConfig>,
): { name: string; host: string; port?: number }[] {
  return Object.keys(config.hosts ?? {})
    .map((name) => {
      const bound = resolveBoundHostAlias(config, name)
      return bound ? { name, host: bound.host, ...(bound.port ? { port: bound.port } : {}) } : null
    })
    .filter((entry): entry is { name: string; host: string; port?: number } => entry !== null)
}

/**
 * Write a starter config to the repo's tracked `quimby.yaml`. Refuses to overwrite an existing file
 * unless `force`, since it is the shared, authored file — never clobbered silently. Returns the path.
 */
export async function scaffoldQuimbyConfig(
  repoRoot: string,
  config: Readonly<QuimbyConfig>,
  opts: Readonly<{ force?: boolean }> = {},
): Promise<string> {
  const path = getProjectConfigPath(repoRoot)
  if (!opts.force && (await exists(path))) {
    throw new QuimbyError(
      'A quimby.yaml already exists here. Edit it, or pass --force to overwrite it.',
    )
  }
  await writeYaml(path, config)
  return path
}

const ENGINES: Record<StarterEngine, RuntimeProfileConfig> = {
  claude: { runtime: 'local', entrypoint: 'claude' },
  codex: { runtime: 'local', entrypoint: 'codex' },
  'sbx-claude': { runtime: 'sbx', entrypoint: 'claude' },
  'sbx-codex': { runtime: 'sbx', entrypoint: 'codex' },
}
