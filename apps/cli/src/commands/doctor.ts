import { QuimbyError } from '@quimbyhq/errors'
import { resolveAgentLaunchDefaults } from '@quimbyhq/launch'
import { resolveRuntimeSelection } from '@quimbyhq/runtime-profile'
import { parseCommand, runtimeTypes } from '@quimbyhq/runtimes'
import { getSSHTransport } from '@quimbyhq/transport'
import type { SSHLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { loadQuimbyConfig, resolveSSHConnection, resolveWorkspace } from '@quimbyhq/workspace'
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
    runtimeProfile: {
      type: 'string',
      description: 'Runtime profile to check',
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
  args: { agent?: string; runtime?: string; runtimeProfile?: string; hostAlias?: string }
}) {
  const { state, repoRoot } = await resolveWorkspace()
  const config = await loadQuimbyConfig(repoRoot)
  const agent = args.agent ? state.agents[args.agent] : undefined
  if (args.agent && !agent) throw new QuimbyError(`Agent "${args.agent}" not found`)

  const rawLocation: SSHLocation | undefined = isSSH(agent?.location)
    ? agent.location
    : args.hostAlias
      ? { type: 'ssh', alias: args.hostAlias }
      : undefined
  let location: (SSHLocation & { host: string }) | undefined
  if (rawLocation) {
    const res = resolveSSHConnection(config, rawLocation)
    if (res.unboundAlias) {
      logger.warn(
        `Host alias "${res.unboundAlias}" is not bound to an address. Bind it with ` +
          `\`quimby host ${res.unboundAlias} --set <user@host>\` (or run the agent to be prompted), then re-run doctor.`,
      )
      return
    }
    location = res.location
  }
  const selection = resolveRuntimeSelection({
    config,
    saved: agent ? resolveAgentLaunchDefaults(agent, config) : config.defaults,
    runtimeProfile: args.runtimeProfile,
    runtime: args.runtime,
  })
  const { runtime, entrypoint, requiredTools } = selection
  const entrypointCommand = parseCommand(entrypoint).command

  // The entrypoint (e.g. `claude`) is a host dependency only for the `local`
  // runtime, where it runs directly on the host. A sandbox runtime (`sbx`,
  // `openshell`) runs the entrypoint inside the sandbox — the host just needs
  // the runtime CLI, which `requiredTools` already carries — so checking for
  // the entrypoint on the host would wrongly report it missing.
  const required = [
    'git',
    ...(location ? ['rsync', 'tmux'] : []),
    ...requiredTools,
    ...(runtime === 'local' ? [entrypointCommand] : []),
  ]

  logger.start(`Checking ${location ? `remote host ${location.host}` : 'local host'} (${runtime})`)
  const results = location ? await checkRemote(location, required) : await checkLocal(required)

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

interface CheckResult {
  name: string
  present: boolean
}
