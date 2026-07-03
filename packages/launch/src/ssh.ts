import {
  cloneAndSeedRemoteAgentRepo,
  renderRemoteMailboxMigration,
  writeRemoteAgentScaffold,
} from '@quimbyhq/agent'
import {
  remoteAgentDir,
  remoteAgentRepoDir,
  remoteProjectRoot,
  remoteTmuxConfigPath,
  tmuxSessionName,
} from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { getRuntime } from '@quimbyhq/runtimes'
import { renderTmuxConfig } from '@quimbyhq/template'
import type { SSHTransport } from '@quimbyhq/transport'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { SSHLocation } from '@quimbyhq/types'
import { saveState } from '@quimbyhq/workspace'

import type { LaunchOptions } from './local'
import { resolveRuntimeSelection } from './runtime'

/**
 * The remote-side twin of a local launch: the pieces of a `tmux … new-session` to run
 * over transport on an SSH host, after syncing the project and lazily initializing the
 * remote agent on first launch. The caller assembles the transport call (attach vs
 * detached) from these fields.
 */
export interface SshLaunch {
  transport: SSHTransport
  host: string
  sessionName: string
  tmuxConf: string
  cwd: string
  shellCmd: string
  windowName: string
  runtimeLabel: string
}

/**
 * Prepare an SSH agent's remote tmux launch: rsync the project, migrate a legacy
 * name-keyed remote dir, lazily clone + tag + scaffold on first launch (persisting the
 * seed commit), build the remote launch command, and write the remote tmux config.
 * Does not spawn tmux — the caller decides attach vs detached. Shared by `run`, `start`,
 * and the dashboard, so the one-time remote-init sequence exists in exactly one place.
 */
export async function prepareSshLaunch(
  opts: Readonly<LaunchOptions & { location: SSHLocation }>,
  reporter: Reporter = silentReporter,
): Promise<SshLaunch> {
  const { state, repoRoot, agent, location: loc } = opts
  const transport = getSSHTransport(loc)
  const rRoot = remoteProjectRoot(state.id, loc.base)
  const rAgentDir = remoteAgentDir(state.id, agent.id, loc.base)
  const rRepoDir = remoteAgentRepoDir(state.id, agent.id, loc.base)

  reporter.start(`Syncing project to ${loc.host}...`)
  await transport.syncProjectTo(repoRoot, rRoot)

  // One-time migration of a remote agent dir from the legacy name-keyed layout to the
  // UUID-keyed one, so an existing remote agent's work isn't re-cloned away.
  const rLegacyAgentDir = remoteAgentDir(state.id, agent.name, loc.base)
  if (rLegacyAgentDir !== rAgentDir) {
    await transport.exec(
      `if [ -d ${rLegacyAgentDir} ] && [ ! -d ${rAgentDir} ]; then mkdir -p "$(dirname ${rAgentDir})" && mv ${rLegacyAgentDir} ${rAgentDir}; fi`,
    )
  }

  // Reshape a legacy inbox/outbox mailbox into the handoff/ tree (once), after the dir is at
  // its id-keyed path so it operates on the right agent dir.
  await transport.exec(renderRemoteMailboxMigration(rAgentDir))

  // Lazy remote init: clone + scaffold the agent if this is the first launch. Reuses the
  // same provisioning primitives as `rebuildAgent`, so remote clone/seed/scaffold lives
  // in one place.
  const repoReady = await transport.fileExists(`${rRepoDir}/.git`)
  if (!repoReady) {
    await transport.checkCapabilities(['git', 'rsync', 'tmux'])
    reporter.start('Initializing remote agent...')
    state.agents[agent.name].seedCommit = await cloneAndSeedRemoteAgentRepo(transport, {
      rRoot,
      rRepoDir,
      agentName: agent.name,
      hostRepoRoot: repoRoot,
    })
    await writeRemoteAgentScaffold(transport, rAgentDir, {
      agentName: agent.name,
      agentId: agent.id,
      withClaudeMd: true,
    })
    await saveState(repoRoot, state)
    reporter.success('Remote agent initialized')
  }

  const { runtime, entrypoint, runtimeLabel } = resolveRuntimeSelection(opts)

  // Build the shell command for the remote machine using the runtime adapter; cwd is
  // handled by tmux -c, so we pass remote paths but don't use spec.cwd.
  const adapter = getRuntime(runtime)
  const spec = await adapter.runSpec(
    {
      projectId: state.id,
      agentId: agent.id,
      agentName: agent.name,
      agentDir: rAgentDir,
      repoDir: rRepoDir,
      repoRoot: rRoot,
    },
    entrypoint,
  )
  // Quote the user-supplied entrypoint wherever it appears; leave the runtime's own
  // static tokens (e.g. 'run', 'sandbox') unquoted.
  const launchCmd = [spec.command, ...spec.args.map((a) => (a === entrypoint ? sq(a) : a))].join(
    ' ',
  )
  // Refresh the window label on every (re)attach so it tracks renames.
  const shellCmd = `tmux rename-window ${sq(agent.name)} 2>/dev/null; ${launchCmd}`

  // Quimby runs its own tmux server (-L) with its own config (-f); written fresh each
  // launch since tmux reads -f only at server start.
  const tmuxConf = remoteTmuxConfigPath(state.id, loc.base)
  await transport.writeFile(tmuxConf, renderTmuxConfig())

  return {
    transport,
    host: loc.host,
    sessionName: tmuxSessionName(agent.id),
    tmuxConf,
    cwd: rAgentDir,
    shellCmd,
    windowName: agent.name,
    runtimeLabel,
  }
}
