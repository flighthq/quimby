import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { runtimeTypes } from '@quimbyhq/runtimes'
import type { RuntimeType, SSHLocation } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { addWorker, setWorkerCheck } from '@quimbyhq/worker'
import { defineCommand } from 'citty'

import { buildSSHLocation, runWorkerWalkthrough } from '../walkthrough'

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
    sync: {
      type: 'string',
      alias: 's',
      description: 'Ref to sync against (default: current host branch)',
    },
  },
  run: runAddCommand,
})

export async function runAddCommand({
  args,
}: {
  args: {
    name: string
    runtime?: string
    agent?: string
    host?: string
    port?: string
    sync?: string
  }
}) {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) {
    throw new QuimbyError('Not inside a git repository.')
  }

  // With no config flags, walk the user through the worker's setup; with flags,
  // honor them verbatim so `add` stays scriptable for unattended use.
  const hasFlags = Boolean(args.runtime || args.agent || args.host || args.port || args.sync)

  let defaults: { runtime?: string; agent?: string } | undefined
  let location: SSHLocation | undefined
  let syncRef: string | undefined
  let check: string | undefined
  let tmux: boolean | undefined

  if (hasFlags) {
    if (args.runtime && !runtimeTypes.includes(args.runtime as RuntimeType)) {
      throw new QuimbyError(
        `Unknown runtime "${args.runtime}". Available: ${runtimeTypes.join(', ')}`,
      )
    }
    defaults = args.runtime || args.agent ? { runtime: args.runtime, agent: args.agent } : undefined
    if (args.host) {
      location = buildSSHLocation(args.host, args.port ? Number.parseInt(args.port, 10) : undefined)
    }
    syncRef = args.sync
  } else {
    const config = await runWorkerWalkthrough(args.name)
    if (!config) return
    defaults = { runtime: config.runtime, agent: config.agent }
    location = config.location
    syncRef = config.syncRef
    check = config.check
    tmux = config.tmux
  }

  const workerState = await addWorker(repoRoot, args.name, {
    defaults,
    location,
    ...(syncRef ? { syncRef } : {}),
    ...(tmux ? { tmux: true } : {}),
  })
  if (check) {
    await setWorkerCheck(repoRoot, args.name, check)
  }

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
