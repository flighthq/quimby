import { addAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { runtimeTypes } from '@quimbyhq/runtimes'
import { buildSSHLocation } from '@quimbyhq/transport'
import type { AgentDefaults, AgentLocation, RuntimeType } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import {
  loadQuimbyConfig,
  normalizeCheck,
  resolveHostAlias,
  resolveRole,
} from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { resolveWalkthroughConfig, runAgentWalkthrough } from '../walkthrough'

export default defineCommand({
  meta: {
    name: 'add',
    description: 'Create a new agent',
  },
  args: {
    agent: {
      type: 'positional',
      description:
        'Name for the agent (omit with --role to auto-label the next <role>/<role>-N slot)',
      required: false,
    },
    runtime: {
      type: 'string',
      alias: 'r',
      description: `Runtime environment (${runtimeTypes.join(', ')})`,
    },
    cmd: {
      type: 'string',
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
    role: {
      type: 'string',
      description: 'Role from quimby.yaml to use as creation defaults',
    },
    runtimeProfile: {
      type: 'string',
      alias: 'profile',
      description:
        'Runtime profile from quimby config (with --role, pins this instance to that engine)',
    },
    hostAlias: {
      type: 'string',
      description: 'Private host alias from user/local config',
    },
  },
  run: runAddCommand,
})

export async function runAddCommand({
  args,
}: {
  args: {
    agent?: string
    runtime?: string
    cmd?: string
    host?: string
    port?: string
    sync?: string
    role?: string
    runtimeProfile?: string
    hostAlias?: string
  }
}) {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) {
    throw new QuimbyError('Not inside a git repository.')
  }

  // With no config flags, walk the user through the agent's setup; with flags,
  // honor them verbatim so `add` stays scriptable for unattended use.
  const hasFlags = Boolean(
    args.runtime ||
    args.cmd ||
    args.host ||
    args.port ||
    args.sync ||
    args.role ||
    args.runtimeProfile ||
    args.hostAlias,
  )

  let role: string | undefined
  let runtimeProfilePin: string | undefined
  let defaults: AgentDefaults | undefined
  let location: AgentLocation | undefined
  let syncRef: string | undefined
  let tmux: boolean | undefined
  let check: string | undefined
  let verifyByDefault: boolean | undefined

  if (hasFlags) {
    const config = await loadQuimbyConfig(repoRoot)
    const roleCfg = args.role ? resolveRole(config, args.role) : config.defaults
    const runtimeProfile =
      args.runtimeProfile ?? (args.runtime || args.cmd ? undefined : roleCfg?.runtimeProfile)
    if (args.runtime && !runtimeTypes.includes(args.runtime as RuntimeType)) {
      throw new QuimbyError(
        `Unknown runtime "${args.runtime}". Available: ${runtimeTypes.join(', ')}`,
      )
    }
    defaults =
      runtimeProfile || roleCfg?.runtime || roleCfg?.entrypoint || args.runtime || args.cmd
        ? {
            ...(runtimeProfile ? { runtimeProfile } : {}),
            runtime: args.runtime ?? roleCfg?.runtime,
            entrypoint: args.cmd ?? roleCfg?.entrypoint,
          }
        : undefined
    if (args.host) {
      location = buildSSHLocation(args.host, args.port ? Number.parseInt(args.port, 10) : undefined)
    } else if (args.hostAlias) {
      // Store the alias reference, not a flattened address, so the concrete host is
      // resolved from private config at launch (and a rebinding propagates). resolveHostAlias
      // asserts the alias is at least declared in config.
      resolveHostAlias(config, args.hostAlias)
      location = { type: 'ssh', alias: args.hostAlias }
    }
    syncRef = args.sync ?? roleCfg?.syncRef
    tmux = roleCfg?.tmux
    const checkConfig = normalizeCheck(roleCfg?.check)
    check = checkConfig?.command
    verifyByDefault = checkConfig?.verifyByDefault ?? roleCfg?.verifyByDefault
    role = args.role
    // An explicit --profile with a --role pins this instance to that engine, overriding the
    // role's default — so a same-role +1 (a Codex `builder` beside Claude ones) actually runs it.
    runtimeProfilePin = args.role && args.runtimeProfile ? args.runtimeProfile : undefined
  } else {
    if (!args.agent) {
      throw new QuimbyError(
        'Provide an agent name (e.g. `quimby add builder`), or flags to skip the walkthrough.',
      )
    }
    // Flag-less: the config-aware walkthrough returns references (role / profile pin / alias),
    // which resolveWalkthroughConfig normalizes into one coherent engine authority.
    const walkConfig = await loadQuimbyConfig(repoRoot)
    const result = await runAgentWalkthrough(args.agent, walkConfig, repoRoot)
    if (!result) return
    const resolved = resolveWalkthroughConfig(result)
    role = resolved.role
    runtimeProfilePin = resolved.runtimeProfile
    defaults = resolved.defaults
    location = resolved.location.type === 'ssh' ? resolved.location : undefined
    syncRef = resolved.syncRef
    tmux = resolved.tmux
  }

  const agentState = await addAgent(repoRoot, args.agent, {
    ...(role ? { role } : {}),
    ...(runtimeProfilePin ? { runtimeProfile: runtimeProfilePin } : {}),
    defaults,
    location,
    ...(syncRef ? { syncRef } : {}),
    ...(tmux ? { tmux: true } : {}),
    ...(check ? { check } : {}),
    ...(verifyByDefault ? { verifyByDefault: true } : {}),
  })

  const locationHint =
    location?.type === 'ssh' ? ` [ssh: ${location.host ?? `@${location.alias ?? '?'}`}]` : ''
  // The pin is the launch-time engine, so it leads the hint; else the flattened defaults, else the role.
  const defaultsHint = runtimeProfilePin
    ? ` (profile: ${runtimeProfilePin}${role ? `, role: ${role}` : ''})`
    : defaults
      ? ` (${[defaults.runtime, defaults.entrypoint].filter(Boolean).join(', ')})`
      : role
        ? ` (role: ${role})`
        : ''

  logger.success(
    `Agent "${agentState.name}" created (seed: ${agentState.seedCommit.slice(0, 8)})${locationHint}${defaultsHint}`,
  )
  if (location?.type === 'ssh') {
    logger.info('Remote agent created — run `quimby run` to sync and initialize.')
  }
}
