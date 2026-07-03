import {
  setAgentCheckCommand,
  setAgentDefaults,
  setAgentLocation,
  setAgentSyncRef,
} from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { runtimeTypes } from '@quimbyhq/runtimes'
import { mergeSSHLocation } from '@quimbyhq/transport'
import type { RuntimeType } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'set',
    description: 'Update agent config',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent name',
      required: true,
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
      description: 'Update SSH host (e.g. user@box or user@box:/remote/path)',
    },
    port: {
      type: 'string',
      description: 'Update SSH port',
    },
    local: {
      type: 'boolean',
      description: 'Convert an SSH agent back to local (drops its remote location)',
      default: false,
    },
    sync: {
      type: 'string',
      alias: 's',
      description: 'Retarget the ref `quimby sync` syncs against (e.g. main, release)',
    },
    check: {
      type: 'string',
      description:
        'The agent\'s self-verification command (e.g. "npm run ci"); the agent runs it and attests. Pass "" to clear',
    },
  },
  run: runSetCommand,
})

export async function runSetCommand({
  args,
}: {
  args: {
    agent: string
    runtime?: string
    cmd?: string
    host?: string
    port?: string
    sync?: string
    local?: boolean
    check?: string
  }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.agent]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }

  if (
    !args.runtime &&
    !args.cmd &&
    !args.host &&
    !args.port &&
    args.sync === undefined &&
    !args.local &&
    args.check === undefined
  ) {
    throw new QuimbyError(
      'Specify at least one of --runtime, --cmd, --host, --port, --sync, --local, or --check',
    )
  }

  // --local drops the remote location; it can't coexist with --host/--port, which set one.
  if (args.local && (args.host || args.port)) {
    throw new QuimbyError('--local cannot be combined with --host/--port')
  }

  if (args.runtime && !runtimeTypes.includes(args.runtime as RuntimeType)) {
    throw new QuimbyError(
      `Unknown runtime "${args.runtime}". Available: ${runtimeTypes.join(', ')}`,
    )
  }

  if (args.runtime || args.cmd) {
    const updates: { runtime?: string; entrypoint?: string } = {}
    if (args.runtime) updates.runtime = args.runtime
    if (args.cmd) updates.entrypoint = args.cmd
    await setAgentDefaults(repoRoot, args.agent, updates)
  }

  if (args.sync !== undefined) {
    if (!args.sync) {
      throw new QuimbyError('--sync requires a ref (e.g. main, release)')
    }
    await setAgentSyncRef(repoRoot, args.agent, args.sync)
  }

  if (args.check !== undefined) {
    await setAgentCheckCommand(repoRoot, args.agent, args.check || undefined)
  }

  if (args.local) {
    if (!isSSH(agent.location)) {
      throw new QuimbyError(`Agent "${args.agent}" is already local`)
    }
    await setAgentLocation(repoRoot, args.agent, { type: 'local' })
  }

  if (args.host || args.port) {
    const location = mergeSSHLocation(agent.location, {
      hostSpec: args.host,
      port: args.port ? parseInt(args.port, 10) : undefined,
    })
    if (!location) {
      throw new QuimbyError('Agent has no SSH host — provide --host to set one')
    }
    await setAgentLocation(repoRoot, args.agent, location)
  }

  logger.success(`Agent "${args.agent}" updated`)
}
