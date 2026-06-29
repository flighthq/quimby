import { setAgentDefaults, setAgentLocation, setAgentSyncRef } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { runtimeTypes } from '@quimbyhq/runtimes'
import type { RuntimeType } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'set',
    description: 'Update agent config',
  },
  args: {
    name: {
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
      alias: 'c',
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
    sync: {
      type: 'string',
      alias: 's',
      description: 'Retarget the ref `quimby sync` syncs against (e.g. main, release)',
    },
  },
  run: runSetCommand,
})

export async function runSetCommand({
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
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.agents[args.name]) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
  }

  if (!args.runtime && !args.cmd && !args.host && !args.port && args.sync === undefined) {
    throw new QuimbyError('Specify at least one of --runtime, --cmd, --host, --port, or --sync')
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
    await setAgentDefaults(repoRoot, args.name, updates)
  }

  if (args.sync !== undefined) {
    if (!args.sync) {
      throw new QuimbyError('--sync requires a ref (e.g. main, release)')
    }
    await setAgentSyncRef(repoRoot, args.name, args.sync)
  }

  if (args.host || args.port) {
    const current = state.agents[args.name].location
    const colonSlash = args.host ? args.host.indexOf(':/') : -1
    const sshHost = args.host
      ? colonSlash >= 0
        ? args.host.slice(0, colonSlash)
        : args.host
      : (current as { host?: string })?.host
    const base = args.host && colonSlash >= 0 ? args.host.slice(colonSlash + 1) : undefined
    const port = args.port ? parseInt(args.port, 10) : (current as { port?: number })?.port

    if (!sshHost) {
      throw new QuimbyError('Agent has no SSH host — provide --host to set one')
    }

    await setAgentLocation(repoRoot, args.name, {
      type: 'ssh',
      host: sshHost,
      ...(port ? { port } : {}),
      ...(base ? { base } : {}),
    })
  }

  logger.success(`Agent "${args.name}" updated`)
}
