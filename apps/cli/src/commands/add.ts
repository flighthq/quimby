import { addAgent, setAgentGuard } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { runtimeTypes } from '@quimbyhq/runtimes'
import type { RuntimeType, SSHLocation } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { defineCommand } from 'citty'

import { buildSSHLocation, runAgentWalkthrough } from '../walkthrough'

export default defineCommand({
  meta: {
    name: 'add',
    description: 'Create a new agent',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Name for the agent',
      required: true,
    },
    runtime: {
      type: 'string',
      alias: 'r',
      description: `Runtime environment (${runtimeTypes.join(', ')})`,
    },
    cmd: {
      type: 'string',
      alias: 'c',
      description: 'Entrypoint command to launch (e.g. claude, codex)',
    },
    host: {
      type: 'string',
      alias: 'H',
      description: 'SSH host for remote agent (e.g. user@box or user@box:/remote/path)',
    },
    port: {
      type: 'string',
      description: 'SSH port for remote agent (default: 22)',
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
    cmd?: string
    host?: string
    port?: string
    sync?: string
  }
}) {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) {
    throw new QuimbyError('Not inside a git repository.')
  }

  // With no config flags, walk the user through the agent's setup; with flags,
  // honor them verbatim so `add` stays scriptable for unattended use.
  const hasFlags = Boolean(args.runtime || args.cmd || args.host || args.port || args.sync)

  let defaults: { runtime?: string; entrypoint?: string } | undefined
  let location: SSHLocation | undefined
  let syncRef: string | undefined
  let guard: string | undefined
  let tmux: boolean | undefined

  if (hasFlags) {
    if (args.runtime && !runtimeTypes.includes(args.runtime as RuntimeType)) {
      throw new QuimbyError(
        `Unknown runtime "${args.runtime}". Available: ${runtimeTypes.join(', ')}`,
      )
    }
    defaults =
      args.runtime || args.cmd ? { runtime: args.runtime, entrypoint: args.cmd } : undefined
    if (args.host) {
      location = buildSSHLocation(args.host, args.port ? Number.parseInt(args.port, 10) : undefined)
    }
    syncRef = args.sync
  } else {
    const config = await runAgentWalkthrough(args.name)
    if (!config) return
    defaults = { runtime: config.runtime, entrypoint: config.entrypoint }
    location = config.location
    syncRef = config.syncRef
    guard = config.guard
    tmux = config.tmux
  }

  const agentState = await addAgent(repoRoot, args.name, {
    defaults,
    location,
    ...(syncRef ? { syncRef } : {}),
    ...(tmux ? { tmux: true } : {}),
  })
  if (guard) {
    await setAgentGuard(repoRoot, args.name, guard)
  }

  const locationHint = location ? ` [ssh: ${location.host}]` : ''
  const defaultsHint = defaults
    ? ` (${[defaults.runtime, defaults.entrypoint].filter(Boolean).join(', ')})`
    : ''

  logger.success(
    `Agent "${args.name}" created (seed: ${agentState.seedCommit.slice(0, 8)})${locationHint}${defaultsHint}`,
  )
  if (location) {
    logger.info('Remote agent created — run `quimby run` to sync and initialize.')
  }
}
