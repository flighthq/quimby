import {
  cloneAndSeedRemoteAgentRepo,
  configureRemoteAgentIdentity,
  renderRemoteMailboxMigration,
  writeRemoteAgentInstructions,
  writeRemoteAgentScaffold,
} from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
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
import { reconcileAgentStatusMirror } from '@quimbyhq/status'
import { renderTmuxConfig } from '@quimbyhq/template'
import type { SSHTransport } from '@quimbyhq/transport'
import { getSSHTransport, sp, sq } from '@quimbyhq/transport'
import type { SSHLocation } from '@quimbyhq/types'
import { isResolvedSSHLocation } from '@quimbyhq/types'
import { loadQuimbyConfig, saveState } from '@quimbyhq/workspace'

import type { LaunchOptions } from './local'
import { resolveRuntimeSelection } from './runtime'
import { tmuxSetQuimbyRootShell } from './tmux'

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
  rootCwd: string
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
  if (!isResolvedSSHLocation(loc)) {
    throw new QuimbyError(
      `SSH agent "${agent.name}" has an unbound host alias "${loc.alias ?? '?'}". Bind it with \`quimby host ${loc.alias ?? '<alias>'} --set <user@host>\` or run interactively to be prompted.`,
    )
  }
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
      `if [ -d ${sp(rLegacyAgentDir)} ] && [ ! -d ${sp(rAgentDir)} ]; then mkdir -p "$(dirname ${sp(rAgentDir)})" && mv ${sp(rLegacyAgentDir)} ${sp(rAgentDir)}; fi`,
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
    })
    await saveState(repoRoot, state)
    reporter.success('Remote agent initialized')
  } else {
    await transport.checkCapabilities(['tmux'])
  }

  // Re-apply the git identity and refresh the Quimby-tier instruction files on every launch (not
  // just first-run init above), so fixing the host identity or shipping newer instructions reaches
  // an existing remote agent without a rebuild. Both idempotent and best-effort — a transient
  // remote hiccup must never block attaching.
  const instructionOpts = { agentName: agent.name, agentId: agent.id }
  try {
    await configureRemoteAgentIdentity(transport, rRepoDir, agent.name, repoRoot)
    await writeRemoteAgentInstructions(transport, rAgentDir, instructionOpts)
    // Seed this remote agent's peer roster so `ls status/` is correct even with no server —
    // a placeholder per current peer, orphans swept. Idempotent; the poller refreshes content.
    await reconcileAgentStatusMirror(repoRoot, state, agent.name)
  } catch {
    // Advisory; leave whatever the remote clone already has.
  }

  const config = await loadQuimbyConfig(repoRoot)
  const { runtime, entrypoint, runtimeLabel, env, requiredTools } = resolveRuntimeSelection({
    ...opts,
    config,
  })
  if (requiredTools.length > 0) await transport.checkCapabilities(requiredTools)

  // Build the shell command for the remote machine using the runtime adapter; cwd is
  // handled by tmux -c, so we pass remote paths but don't use spec.cwd.
  const adapter = getRuntime(runtime)
  const rawSpec = await adapter.runSpec(
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
  const spec = { ...rawSpec, env: { ...env, ...(rawSpec.env ?? {}) } }
  // Quote the user-supplied entrypoint wherever it appears; leave the runtime's own
  // static tokens (e.g. 'run', 'sandbox') unquoted.
  const envPrefix = Object.entries(spec.env ?? {})
    .map(([key, value]) => `${key}=${sq(value)}`)
    .join(' ')
  const launchCmd = [envPrefix, [spec.command, ...spec.args].map(sq).join(' ')]
    .filter(Boolean)
    .join(' ')
  // Refresh the window label on every (re)attach so it tracks renames.
  const rootCmd = tmuxSetQuimbyRootShell(rRoot)
  const shellCmd = `${rootCmd}tmux rename-window ${sq(agent.name)} 2>/dev/null; ${launchCmd}`

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
    rootCwd: rRoot,
    shellCmd,
    windowName: agent.name,
    runtimeLabel,
  }
}
