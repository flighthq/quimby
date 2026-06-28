import { addWorker } from '@quimbyhq/core'
import { runtimeTypes } from '@quimbyhq/core'
import { QuimbyError } from '@quimbyhq/core'
import { git } from '@quimbyhq/core'
import { logger } from '@quimbyhq/core'
import type { SSHLocation } from '@quimbyhq/types'
import type { RuntimeType } from '@quimbyhq/types'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'add',
    description: 'Create a new worker',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Name for the worker',
      required: true,
    },
    runtime: {
      type: 'string',
      alias: 'r',
      description: `Runtime environment (${runtimeTypes.join(', ')})`,
    },
    agent: {
      type: 'string',
      alias: 'a',
      description: 'Agent to run (e.g. claude, codex)',
    },
    host: {
      type: 'string',
      alias: 'H',
      description: 'SSH host for remote worker (e.g. user@box or user@box:/remote/path)',
    },
    port: {
      type: 'string',
      description: 'SSH port for remote worker (default: 22)',
    },
  },
  run,
})

async function run({
  args,
}: {
  args: { name: string; runtime?: string; agent?: string; host?: string; port?: string }
}) {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) {
    throw new QuimbyError('Not inside a git repository.')
  }

  if (args.runtime && !runtimeTypes.includes(args.runtime as RuntimeType)) {
    throw new QuimbyError(
      `Unknown runtime "${args.runtime}". Available: ${runtimeTypes.join(', ')}`,
    )
  }

  const defaults =
    args.runtime || args.agent ? { runtime: args.runtime, agent: args.agent } : undefined

  let location: SSHLocation | undefined
  if (args.host) {
    // Accept  user@host  or  user@host:/remote/path
    const colonSlash = args.host.indexOf(':/')
    const sshHost = colonSlash >= 0 ? args.host.slice(0, colonSlash) : args.host
    const base = colonSlash >= 0 ? args.host.slice(colonSlash + 1) : undefined
    const port = args.port ? parseInt(args.port, 10) : undefined
    location = {
      type: 'ssh',
      host: sshHost,
      ...(port ? { port } : {}),
      ...(base ? { base } : {}),
    }
  }

  const workerState = await addWorker(repoRoot, args.name, { defaults, location })

  const locationHint = location ? ` [ssh: ${location.host}]` : ''
  const defaultsHint = defaults
    ? ` (${[defaults.runtime, defaults.agent].filter(Boolean).join(', ')})`
    : ''

  logger.success(
    `Worker "${args.name}" created (seed: ${workerState.seedCommit.slice(0, 8)})${locationHint}${defaultsHint}`,
  )
  if (location) {
    logger.info('Remote worker created — run `quimby run` to sync and initialize.')
  }
}
