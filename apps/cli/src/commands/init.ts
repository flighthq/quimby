import { cancel, intro, isCancel, outro, select, text } from '@clack/prompts'
import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import type { QuimbyConfig, RuntimeProfileConfig } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import type { StarterEngine, StarterName, StarterOptions } from '@quimbyhq/workspace'
import {
  buildStarterConfig,
  listBoundHostAliases,
  listRuntimeProfiles,
  listStarters,
  loadQuimbyConfig,
  scaffoldQuimbyConfig,
} from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

const ENGINE_CHOICES: { value: StarterEngine; label: string }[] = [
  { value: 'claude', label: 'Claude (local)' },
  { value: 'codex', label: 'Codex (local)' },
  { value: 'sbx-claude', label: 'Claude in a sandbox (sbx)' },
  { value: 'sbx-codex', label: 'Codex in a sandbox (sbx)' },
]

export default defineCommand({
  meta: {
    name: 'init',
    description: 'Scaffold a starter quimby.yaml (roles, profiles, presets) for a new project',
  },
  args: {
    starter: {
      type: 'positional',
      description: `Starter to scaffold (${listStarters()
        .map((s) => s.name)
        .join(', ')}); omit for an interactive walkthrough`,
      required: false,
    },
    list: {
      type: 'boolean',
      default: false,
      description: 'List the available starters and exit',
    },
    force: {
      type: 'boolean',
      default: false,
      description: 'Overwrite an existing quimby.yaml',
    },
  },
  run: runInitCommand,
})

export async function runInitCommand({
  args,
}: {
  args: { starter?: string; list?: boolean; force?: boolean }
}) {
  if (args.list) {
    logger.info('Available starters:')
    for (const s of listStarters()) logger.info(`  ${s.name}  —  ${s.description}`)
    return
  }

  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) throw new QuimbyError('Not inside a git repository (quimby.yaml lives at the repo root).') // prettier-ignore

  const plan = args.starter
    ? { name: assertStarter(args.starter), opts: {} }
    : await walkthrough(repoRoot)
  if (!plan) return

  const config = buildStarterConfig(plan.name, plan.opts)
  const path = await scaffoldQuimbyConfig(repoRoot, config, { force: args.force })

  logger.success(`Wrote ${path} (starter "${plan.name}").`)
  logger.info('Next: `quimby up` to create its agents, then `quimby run` to open the dashboard.')
}

// Interactive: pick a starter, then customize engine, replica count, and location — reusing any
// host alias already bound in this machine's config so an existing "remote" needs no re-entry.
async function walkthrough(
  repoRoot: string,
): Promise<{ name: StarterName; opts: StarterOptions } | null> {
  intro('Scaffold a quimby.yaml')
  const config = await loadQuimbyConfig(repoRoot)

  const name = await prompt(
    select({
      message: 'Starter',
      options: listStarters().map((s) => ({
        value: s.name,
        label: `${s.name} — ${s.description}`,
      })),
    }),
  )
  if (name === null) return cancelled()

  const engine = await pickEngine(config)
  if (engine === CANCELLED) return cancelled()

  const opts: StarterOptions = { ...engine }

  if (name !== 'solo') {
    const count = await prompt(
      text({
        message: 'How many builders?',
        placeholder: name === 'fleet' ? '3' : '1',
        validate: (v) => (!v || /^\d+$/.test(v.trim()) ? undefined : 'Enter a number'),
      }),
    )
    if (count === null) return cancelled()
    if (count.trim()) opts.builderCount = Number.parseInt(count.trim(), 10)
  }

  const hostAlias = await pickHostAlias(config)
  if (hostAlias === CANCELLED) return cancelled()
  if (hostAlias) opts.hostAlias = hostAlias

  outro(`Ready to scaffold "${name}".`)
  return { name: name as StarterName, opts }
}

// Offer the built-in engines plus any runtime profile the user already declared (reuse), so an
// existing `codex-sbx` needs no re-entry. A reused profile is referenced by name with only its
// shareable shape inlined into the tracked file. Returns starter opts (engine or reuseProfile).
async function pickEngine(
  config: Readonly<QuimbyConfig>,
): Promise<Pick<StarterOptions, 'engine' | 'reuseProfile'> | typeof CANCELLED> {
  const profiles = listRuntimeProfiles(config)
  const choice = await prompt(
    select({
      message: 'Engine',
      options: [
        ...ENGINE_CHOICES,
        ...profiles.map((p) => ({
          value: `${REUSE}${p.name}`,
          label: `Reuse your profile: ${p.name}${profileHint(p.profile)}`,
        })),
      ],
    }),
  )
  if (choice === null) return CANCELLED
  if (choice.startsWith(REUSE)) {
    const name = choice.slice(REUSE.length)
    const found = profiles.find((p) => p.name === name)
    if (found) return { reuseProfile: { name: found.name, profile: found.profile } }
  }
  return { engine: choice as StarterEngine }
}

function profileHint(profile: Readonly<RuntimeProfileConfig>): string {
  const parts = [profile.runtime, profile.entrypoint].filter(Boolean)
  return parts.length ? ` (${parts.join(' / ')})` : ''
}

// Offer host aliases already bound in this machine's config (reuse), a fresh alias declaration, or
// local. Returns the alias name to reference, undefined for local, or CANCELLED.
async function pickHostAlias(
  config: Readonly<QuimbyConfig>,
): Promise<string | undefined | typeof CANCELLED> {
  const bound = listBoundHostAliases(config)

  const choice = await prompt(
    select({
      message: 'Where do agents run?',
      options: [
        { value: LOCAL, label: 'Local' },
        ...bound.map((a) => ({
          value: a.name,
          label: `Reuse alias: ${a.name} (${a.host}${a.port ? `:${a.port}` : ''})`,
        })),
        { value: NEW_ALIAS, label: 'Declare a new host alias…' },
      ],
    }),
  )
  if (choice === null) return CANCELLED
  if (choice === LOCAL) return undefined
  if (choice !== NEW_ALIAS) return choice

  const alias = await prompt(
    text({
      message: 'New alias name',
      placeholder: 'remote',
      validate: (v) => (v?.trim() ? undefined : 'An alias name is required'),
    }),
  )
  if (alias === null) return CANCELLED
  // Declared unbound in the tracked file; bind its address privately with `quimby host <alias> --set`.
  return alias.trim()
}

function assertStarter(name: string): StarterName {
  const known = listStarters().map((s) => s.name)
  if (!known.includes(name as StarterName)) {
    throw new QuimbyError(`Unknown starter "${name}". Available: ${known.join(', ')}`)
  }
  return name as StarterName
}

async function prompt<T>(answer: Promise<T | symbol>): Promise<T | null> {
  const value = await answer
  return isCancel(value) ? null : value
}

function cancelled(): null {
  cancel('Cancelled — nothing written.')
  return null
}

const CANCELLED = Symbol('cancelled')
const LOCAL = '(local)'
const NEW_ALIAS = '(new-alias)'
// Prefix for reused-profile select values, so a user profile named like a built-in engine can't collide.
const REUSE = 'reuse:'
