import { QuimbyError } from '@quimbyhq/errors'
import { runtimeTypes } from '@quimbyhq/runtimes'
import type { RuntimeType } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import {
  setWorkerCheck,
  setWorkerDefaults,
  setWorkerLocation,
  setWorkerSyncRef,
} from '@quimbyhq/worker'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'set',
    description: 'Update worker defaults',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Worker name',
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
      description: 'Update SSH host (e.g. user@box or user@box:/remote/path)',
    },
    port: {
      type: 'string',
      description: 'Update SSH port',
    },
    check: {
      type: 'string',
      alias: 'c',
      description: 'Verification command run by `quimby pack` (empty string clears it)',
    },
    sync: {
      type: 'string',
      alias: 's',
      description: 'Retarget the ref `quimby advance` syncs against (e.g. main, release)',
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
    agent?: string
    host?: string
    port?: string
    check?: string
    sync?: string
  }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  if (!state.workers[args.name]) {
    throw new QuimbyError(`Worker "${args.name}" not found`)
  }

  if (
    !args.runtime &&
    !args.agent &&
    !args.host &&
    !args.port &&
    args.check === undefined &&
    args.sync === undefined
  ) {
    throw new QuimbyError(
      'Specify at least one of --runtime, --agent, --host, --port, --check, or --sync',
    )
  }

  if (args.runtime && !runtimeTypes.includes(args.runtime as RuntimeType)) {
    throw new QuimbyError(
      `Unknown runtime "${args.runtime}". Available: ${runtimeTypes.join(', ')}`,
    )
  }

  if (args.runtime || args.agent) {
    const updates: { runtime?: string; agent?: string } = {}
    if (args.runtime) updates.runtime = args.runtime
    if (args.agent) updates.agent = args.agent
    await setWorkerDefaults(repoRoot, args.name, updates)
  }

  if (args.check !== undefined) {
    await setWorkerCheck(repoRoot, args.name, args.check)
  }

  if (args.sync !== undefined) {
    if (!args.sync) {
      throw new QuimbyError('--sync requires a ref (e.g. main, release)')
    }
    await setWorkerSyncRef(repoRoot, args.name, args.sync)
  }

  if (args.host || args.port) {
    const current = state.workers[args.name].location
    const colonSlash = args.host ? args.host.indexOf(':/') : -1
    const sshHost = args.host
      ? colonSlash >= 0
        ? args.host.slice(0, colonSlash)
        : args.host
      : (current as { host?: string })?.host
    const base = args.host && colonSlash >= 0 ? args.host.slice(colonSlash + 1) : undefined
    const port = args.port ? parseInt(args.port, 10) : (current as { port?: number })?.port

    if (!sshHost) {
      throw new QuimbyError('Worker has no SSH host — provide --host to set one')
    }

    await setWorkerLocation(repoRoot, args.name, {
      type: 'ssh',
      host: sshHost,
      ...(port ? { port } : {}),
      ...(base ? { base } : {}),
    })
  }

  logger.success(`Worker "${args.name}" updated`)
}
