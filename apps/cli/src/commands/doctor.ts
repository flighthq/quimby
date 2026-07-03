import { QuimbyError } from '@quimbyhq/errors'
import { parseCommand, runtimeCli, runtimeTypes } from '@quimbyhq/runtimes'
import { getSSHTransport } from '@quimbyhq/transport'
import type { RuntimeType, SSHLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { loadQuimbyConfig, resolveHostAlias, resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

export default defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check Quimby dependencies for this project, agent, runtime, or host alias',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Optional agent to check',
      required: false,
    },
    runtime: {
      type: 'string',
      alias: 'r',
      description: `Runtime to check (${runtimeTypes.join(', ')})`,
    },
    hostAlias: {
      type: 'string',
      description: 'Private host alias to check',
    },
  },
  run: runDoctorCommand,
})

export async function runDoctorCommand({
  args,
}: {
  args: { agent?: string; runtime?: string; hostAlias?: string }
}) {
  const { state, repoRoot } = await resolveWorkspace()
  const config = await loadQuimbyConfig(repoRoot)
  const agent = args.agent ? state.agents[args.agent] : undefined
  if (args.agent && !agent) throw new QuimbyError(`Agent "${args.agent}" not found`)
  if (args.runtime && !runtimeTypes.includes(args.runtime as RuntimeType)) {
    throw new QuimbyError(
      `Unknown runtime "${args.runtime}". Available: ${runtimeTypes.join(', ')}`,
    )
  }

  const alias = resolveHostAlias(config, args.hostAlias)
  const location = isSSH(agent?.location) ? agent.location : aliasToLocation(alias)
  const runtime = (args.runtime ?? agent?.defaults?.runtime ?? 'local') as RuntimeType
  const entrypoint = agent?.defaults?.entrypoint ?? config.defaults?.entrypoint ?? 'claude'
  const entrypointCommand = parseCommand(entrypoint).command

  const required = [
    'git',
    ...(location ? ['rsync', 'tmux'] : []),
    ...(runtimeCli(runtime) ? [runtimeCli(runtime) as string] : []),
    entrypointCommand,
  ]

  logger.start(
    `Checking ${location ? `remote host ${(location as SSHLocation).host}` : 'local host'} (${runtime})`,
  )
  const results = location
    ? await checkRemote(location as SSHLocation, required)
    : await checkLocal(required)

  let ok = true
  for (const result of results) {
    if (result.present) logger.success(`${result.name}: found`)
    else {
      ok = false
      logger.error(`${result.name}: missing`)
    }
  }
  if (!ok) throw new QuimbyError('Doctor found missing dependencies.')
}

async function checkLocal(required: readonly string[]): Promise<CheckResult[]> {
  return Promise.all(
    unique(required).map(async (name) => ({
      name,
      present: await execa('sh', ['-c', `command -v ${name}`]).then(
        () => true,
        () => false,
      ),
    })),
  )
}

async function checkRemote(
  location: SSHLocation,
  required: readonly string[],
): Promise<CheckResult[]> {
  const transport = getSSHTransport(location)
  return Promise.all(
    unique(required).map(async (name) => ({
      name,
      present: await transport.exec(`command -v ${name}`).then(
        () => true,
        () => false,
      ),
    })),
  )
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function aliasToLocation(alias: ReturnType<typeof resolveHostAlias>): SSHLocation | undefined {
  if (!alias) return undefined
  return {
    type: 'ssh',
    host: alias.host,
    ...(alias.port ? { port: alias.port } : {}),
    ...(alias.base ? { base: alias.base } : {}),
  }
}

interface CheckResult {
  name: string
  present: boolean
}
