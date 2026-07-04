import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { parseSSHHostSpec } from '@quimbyhq/transport'
import type { QuimbyConfig } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import type { HostAliasBinding } from '@quimbyhq/workspace'
import { loadQuimbyConfig, resolveBoundHostAlias, saveHostAliasBinding } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { resolveSSHLocationInteractive } from '../hostAlias'

export default defineCommand({
  meta: {
    name: 'host',
    description: 'Inspect and bind SSH host aliases (addresses stay out of the tracked repo)',
  },
  args: {
    alias: {
      type: 'positional',
      description: 'Host alias to inspect or bind',
      required: false,
    },
    set: {
      type: 'string',
      description: 'Bind the alias to an SSH target (user@host, optionally host:/base/dir)',
    },
    port: {
      type: 'string',
      alias: 'p',
      description: 'SSH port for the binding',
    },
    global: {
      type: 'boolean',
      default: false,
      description: 'Save the binding for all projects (~/.config/quimby/config.yaml)',
    },
  },
  run: runHostCommand,
})

export async function runHostCommand({
  args,
}: {
  args: { alias?: string; set?: string; port?: string; global?: boolean }
}): Promise<void> {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) throw new QuimbyError('Not inside a git repository.')
  const config = await loadQuimbyConfig(repoRoot)

  if (!args.alias) {
    listHostAliases(config)
    return
  }

  if (args.set) {
    const { host, base } = parseSSHHostSpec(args.set.trim())
    const port = args.port ? Number.parseInt(args.port, 10) : undefined
    const binding = { host, ...(base ? { base } : {}), ...(port ? { port } : {}) }
    const path = await saveHostAliasBinding(repoRoot, args.alias, binding, { global: args.global })
    logger.success(`Bound host alias "${args.alias}" → ${host} (${path})`)
    return
  }

  const bound = resolveBoundHostAlias(config, args.alias)
  if (bound) {
    logger.info(`Host alias "${args.alias}" → ${formatBinding(bound)}`)
    return
  }

  // Unbound: prompt interactively (throws with a bind hint when there is no TTY).
  await resolveSSHLocationInteractive(repoRoot, config, { type: 'ssh', alias: args.alias })
}

function listHostAliases(config: Readonly<QuimbyConfig>): void {
  const names = Object.keys(config.hosts ?? {})
  if (names.length === 0) {
    logger.info('No host aliases declared.')
    return
  }
  logger.info('Host aliases:')
  for (const name of names.sort()) {
    const bound = resolveBoundHostAlias(config, name)
    const status = bound
      ? `→ ${formatBinding(bound)}`
      : `(unbound — run \`quimby host ${name}\` to bind)`
    logger.info(`  ${name}  ${status}`)
  }
}

function formatBinding(binding: Readonly<HostAliasBinding>): string {
  const port = binding.port ? `:${binding.port}` : ''
  const base = binding.base ? ` (${binding.base})` : ''
  return `${binding.host}${port}${base}`
}
