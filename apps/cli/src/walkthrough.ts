import { cancel, confirm, intro, isCancel, outro, select, text } from '@clack/prompts'
import { runtimeTypes } from '@quimbyhq/runtimes'
import { buildSSHLocation, parseSSHHostSpec } from '@quimbyhq/transport'
import type {
  AgentDefaults,
  AgentLocation,
  QuimbyConfig,
  RuntimeType,
  SSHLocation,
} from '@quimbyhq/types'
import {
  resolveAgentRoleConfig,
  resolveBoundHostAlias,
  saveHostAliasBinding,
} from '@quimbyhq/workspace'

// The engine source is a discriminant, so persistence can write a single coherent authority
// (role, a per-instance profile pin, or flattened runtime/entrypoint) and clear the rest — see
// resolveWalkthroughConfig. Manual excludes a role (a role would override raw defaults at launch).
export type EngineChoice =
  | { source: 'role' }
  | { source: 'profile'; runtimeProfile: string }
  | { source: 'manual'; runtime: RuntimeType; entrypoint: string }

export interface WalkthroughResult {
  role?: string
  engine: EngineChoice
  location?: SSHLocation
  syncRef?: string
  tmux?: boolean
}

export interface WalkthroughSeed {
  role?: string
  runtimeProfile?: string
  runtime?: string
  entrypoint?: string
  location?: AgentLocation
  syncRef?: string
  tmux?: boolean
}

/**
 * The coherent agent fields a walkthrough result maps to, with exactly one engine authority: a
 * `role` reference, a per-instance `runtimeProfile` pin, or flattened `defaults` — never a mix, so
 * `config`/`add` can persist references (and clear the others) instead of a snapshot the launch
 * resolver would ignore. Pure and side-effect free, so it is unit-tested apart from the prompts.
 */
export function resolveWalkthroughConfig(result: Readonly<WalkthroughResult>): ResolvedAgentConfig {
  const base = {
    location: result.location ?? ({ type: 'local' } as const),
    ...(result.syncRef ? { syncRef: result.syncRef } : {}),
    ...(result.tmux ? { tmux: true } : {}),
  }
  switch (result.engine.source) {
    case 'role':
      return { ...(result.role ? { role: result.role } : {}), ...base }
    case 'profile':
      return {
        ...(result.role ? { role: result.role } : {}),
        runtimeProfile: result.engine.runtimeProfile,
        ...base,
      }
    case 'manual':
      return {
        defaults: { runtime: result.engine.runtime, entrypoint: result.engine.entrypoint },
        ...base,
      }
  }
}

export interface ResolvedAgentConfig {
  role?: string
  runtimeProfile?: string
  defaults?: AgentDefaults
  location: AgentLocation
  syncRef?: string
  tmux?: boolean
}

/**
 * Interactive, arrow-key walkthrough collecting an agent's configuration. Config-aware: when the
 * project's `quimby.yaml` declares roles / runtime profiles / host aliases, it offers them as
 * choices and returns *references* (a role, a profile pin, an alias) rather than a flattened
 * snapshot; with an empty config it degrades to the raw runtime/entrypoint/host flow. Returns null
 * if the user cancels. `repoRoot` is only needed to bind an unbound alias inline; omit to skip that.
 */
export async function runAgentWalkthrough(
  name: string,
  config: Readonly<QuimbyConfig> = {},
  repoRoot?: string,
  seed: Readonly<WalkthroughSeed> = {},
): Promise<WalkthroughResult | null> {
  intro(`Configure agent "${name}"`)

  const role = await pickRole(config, seed)
  if (role === CANCELLED) return cancelled()

  const engine = await pickEngine(config, role, seed)
  if (engine === null) return cancelled()

  const location = await pickLocation(config, repoRoot, seed)
  if (location === CANCELLED) return cancelled()

  let tmux = false
  if (!location) {
    // SSH agents always run in tmux for persistence; only local agents choose.
    const useTmux = await prompt(
      confirm({ message: 'Run inside a tmux session?', initialValue: seed.tmux ?? false }),
    )
    if (useTmux === null) return cancelled()
    tmux = useTmux
  }

  const syncRef = await prompt(
    text({
      message: 'Sync ref (advance target)',
      placeholder: 'current host branch',
      initialValue: seed.syncRef ?? '',
    }),
  )
  if (syncRef === null) return cancelled()

  outro(`Agent "${name}" configured`)

  return {
    ...(role ? { role } : {}),
    engine,
    ...(location ? { location } : {}),
    ...(syncRef.trim() ? { syncRef: syncRef.trim() } : {}),
    ...(tmux ? { tmux: true } : {}),
  }
}

// Returns the chosen role name, undefined for "no role" (or no roles declared), or CANCELLED.
async function pickRole(
  config: Readonly<QuimbyConfig>,
  seed: Readonly<WalkthroughSeed>,
): Promise<string | undefined | typeof CANCELLED> {
  const roles = Object.keys(config.roles ?? {})
  if (roles.length === 0) return undefined
  const choice = await prompt(
    select({
      message: 'Role',
      options: [
        ...roles.map((r) => ({ value: r, label: r })),
        { value: NONE, label: 'None (configure manually)' },
      ],
      initialValue: seed.role && roles.includes(seed.role) ? seed.role : NONE,
    }),
  )
  if (choice === null) return CANCELLED
  return choice === NONE ? undefined : choice
}

// Under a role, the engine is the role's own or a pinned override; without a role, a pinned
// profile or a manual runtime+entrypoint. Returns null on cancel.
async function pickEngine(
  config: Readonly<QuimbyConfig>,
  role: string | undefined,
  seed: Readonly<WalkthroughSeed>,
): Promise<EngineChoice | null> {
  const profiles = Object.keys(config.runtimeProfiles ?? {})

  if (role) {
    if (profiles.length === 0) return { source: 'role' }
    const choice = await prompt(
      select({
        message: 'Engine',
        options: [
          { value: KEEP_ROLE, label: `Keep ${role}'s engine (${roleEngineLabel(config, role)})` },
          ...profiles.map((p) => ({ value: p, label: `Pin profile: ${p}` })),
        ],
        initialValue: seed.runtimeProfile && profiles.includes(seed.runtimeProfile) ? seed.runtimeProfile : KEEP_ROLE, // prettier-ignore
      }),
    )
    if (choice === null) return null
    return choice === KEEP_ROLE ? { source: 'role' } : { source: 'profile', runtimeProfile: choice }
  }

  if (profiles.length > 0) {
    const choice = await prompt(
      select({
        message: 'Engine',
        options: [
          ...profiles.map((p) => ({ value: p, label: `Profile: ${p}` })),
          { value: MANUAL, label: 'Manual (runtime + entrypoint)' },
        ],
        initialValue: seed.runtimeProfile && profiles.includes(seed.runtimeProfile) ? seed.runtimeProfile : MANUAL, // prettier-ignore
      }),
    )
    if (choice === null) return null
    if (choice !== MANUAL) return { source: 'profile', runtimeProfile: choice }
  }

  return pickManualEngine(seed)
}

async function pickManualEngine(seed: Readonly<WalkthroughSeed>): Promise<EngineChoice | null> {
  const seededRuntime = runtimeTypes.find((rt) => rt === seed.runtime) ?? runtimeTypes[0]
  const runtime = await prompt(
    select({
      message: 'Runtime',
      options: runtimeTypes.map((rt, i) => ({ value: rt, label: `${i + 1}. ${rt}` })),
      initialValue: seededRuntime,
    }),
  )
  if (runtime === null) return null

  const entrypoint = await prompt(
    text({
      message: 'Entrypoint command',
      placeholder: 'claude, codex, …',
      initialValue: seed.entrypoint ?? 'claude',
    }),
  )
  if (entrypoint === null) return null

  return { source: 'manual', runtime: runtime as RuntimeType, entrypoint: entrypoint.trim() || 'claude' } // prettier-ignore
}

// Returns undefined for a local agent, an SSHLocation (alias-ref or host-based) for remote, or
// CANCELLED. When an aliased remote's address is unbound and repoRoot is given, offers to bind it.
async function pickLocation(
  config: Readonly<QuimbyConfig>,
  repoRoot: string | undefined,
  seed: Readonly<WalkthroughSeed>,
): Promise<SSHLocation | undefined | typeof CANCELLED> {
  const seedLocal = !seed.location || seed.location.type !== 'ssh'
  const where = await prompt(
    select({
      message: 'Where does this agent run?',
      options: [
        { value: 'local', label: '1. Local' },
        { value: 'ssh', label: '2. Remote (SSH)' },
      ],
      initialValue: seedLocal ? 'local' : 'ssh',
    }),
  )
  if (where === null) return CANCELLED
  if (where === 'local') return undefined

  const aliases = Object.keys(config.hosts ?? {})
  const seedSSH = seed.location?.type === 'ssh' ? seed.location : undefined
  if (aliases.length > 0) {
    const choice = await prompt(
      select({
        message: 'Host',
        options: [
          ...aliases.map((a) => ({ value: a, label: `alias ${a} ${aliasStatus(config, a)}` })),
          { value: MANUAL, label: 'Enter a host manually' },
        ],
        initialValue:
          seedSSH?.alias && aliases.includes(seedSSH.alias) ? seedSSH.alias : aliases[0],
      }),
    )
    if (choice === null) return CANCELLED
    if (choice !== MANUAL) {
      if (!resolveBoundHostAlias(config, choice) && repoRoot) {
        const bound = await bindAliasInline(repoRoot, choice)
        if (bound === CANCELLED) return CANCELLED
      }
      return { type: 'ssh', alias: choice }
    }
  }

  return pickManualHost(seedSSH)
}

async function pickManualHost(
  seedSSH: SSHLocation | undefined,
): Promise<SSHLocation | typeof CANCELLED> {
  const host = await prompt(
    text({
      message: 'SSH host',
      placeholder: 'user@box or user@box:/remote/path',
      initialValue: seedSSH?.host ? formatSSHHost(seedSSH) : '',
      validate: (value) => (value?.trim() ? undefined : 'A host is required for a remote agent'),
    }),
  )
  if (host === null) return CANCELLED

  const portInput = await prompt(
    text({
      message: 'SSH port',
      placeholder: '22',
      initialValue: seedSSH?.port ? String(seedSSH.port) : '',
      validate: (value) =>
        !value || /^\d+$/.test(value.trim()) ? undefined : 'Port must be a number',
    }),
  )
  if (portInput === null) return CANCELLED

  const port = portInput.trim() ? Number.parseInt(portInput.trim(), 10) : undefined
  return buildSSHLocation(host.trim(), port)
}

// Prompt for and persist an unbound alias's address to ignored local config, so the launch never
// has to. Skipping (empty input) leaves the alias unbound — launch will prompt for it then.
async function bindAliasInline(
  repoRoot: string,
  alias: string,
): Promise<'bound' | 'skipped' | typeof CANCELLED> {
  const address = await prompt(
    text({
      message: `Bind alias "${alias}" now? (SSH target, or leave blank to bind later)`,
      placeholder: 'user@box or user@box:/remote/path',
    }),
  )
  if (address === null) return CANCELLED
  if (!address.trim()) return 'skipped'

  const portInput = await prompt(text({ message: 'SSH port', placeholder: '22', initialValue: '' }))
  if (portInput === null) return CANCELLED

  const { host, base } = parseSSHHostSpec(address.trim())
  const port = portInput.trim() ? Number.parseInt(portInput.trim(), 10) : undefined
  await saveHostAliasBinding(repoRoot, alias, {
    host,
    ...(base ? { base } : {}),
    ...(port ? { port } : {}),
  })
  return 'bound'
}

function aliasStatus(config: Readonly<QuimbyConfig>, alias: string): string {
  const bound = resolveBoundHostAlias(config, alias)
  return bound ? `(${bound.host}${bound.port ? `:${bound.port}` : ''})` : '(unbound)'
}

function roleEngineLabel(config: Readonly<QuimbyConfig>, role: string): string {
  const rc = resolveAgentRoleConfig(config, { role })
  if (rc.runtimeProfile) return `profile: ${rc.runtimeProfile}`
  return `${rc.runtime ?? 'local'} / ${rc.entrypoint ?? 'claude'}`
}

function formatSSHHost(location: Readonly<SSHLocation>): string {
  const target = location.host ?? `@${location.alias ?? '?'}`
  return location.base ? `${target}:${location.base}` : target
}

// Normalize a @clack prompt result: a cancellation collapses to null so callers can bail with a
// single check instead of importing the cancel symbol.
async function prompt<T>(answer: Promise<T | symbol>): Promise<T | null> {
  const value = await answer
  return isCancel(value) ? null : value
}

function cancelled(): null {
  cancel('Cancelled — no changes made.')
  return null
}

// Sentinel select values (never collide with a real role/profile/alias name, which are validated
// identifiers) and the cancel marker for helpers that also return `undefined` meaningfully.
const CANCELLED = Symbol('cancelled')
const NONE = '(none)'
const KEEP_ROLE = '(keep-role)'
const MANUAL = '(manual)'
