import { QuimbyError } from '@quimbyhq/errors'
import { quimbyTmuxSocket } from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { buildContext, getRuntime } from '@quimbyhq/runtimes'
import { sq } from '@quimbyhq/transport'
import type { AgentState, QuimbyState, SSHLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { loadQuimbyConfig } from '@quimbyhq/workspace'

import { renderDashboardAttachCommand, renderDashboardPlanCommands } from './dashboardTmux'
import { resolveRuntimeSelection } from './runtime'
import { prepareSshLaunch } from './ssh'
import { QUIMBY_ROOT_TMUX_FORMAT } from './tmux'

/** The reserved name that adds a plain login-shell window (the user's command line). */
export const HOST_WINDOW = 'host'

/** One window in the tabbed dashboard: a name, a working dir, and the command to run. */
export interface WindowSpec {
  name: string
  cwd: string
  rootCwd?: string
  cmd: string[]
  env?: [string, string][]
}

/** A ready-to-run tmux invocation plan: `commands` run in order, then `attach`. */
export interface DashboardPlan {
  commands: string[][]
  attach: string[]
}

/**
 * Build the window specs for a multi-agent dashboard: a `host` window is a login shell;
 * a local agent runs its entrypoint (holding the pane open on failure); an SSH agent
 * SSHes in and attaches its remote tmux session. The SSH window is built from
 * {@link prepareSshLaunch}, so remote sync + lazy init lives in one place, not forked here.
 */
export async function buildDashboardWindows(
  state: Readonly<QuimbyState>,
  repoRoot: string,
  names: readonly string[],
  reporter: Reporter = silentReporter,
): Promise<WindowSpec[]> {
  for (const name of names) {
    if (name !== HOST_WINDOW && !state.agents[name]) {
      throw new QuimbyError(`Agent "${name}" not found`)
    }
  }

  const windows: WindowSpec[] = []
  for (const name of names) {
    if (name === HOST_WINDOW) {
      windows.push({ name: HOST_WINDOW, cwd: repoRoot, rootCwd: repoRoot, cmd: ['bash', '-l'] })
      continue
    }
    const agent = state.agents[name]
    windows.push(
      isSSH(agent.location)
        ? await buildSshWindow(name, agent, agent.location, state, repoRoot, reporter)
        : await buildLocalWindow(name, agent, state, repoRoot),
    )
  }
  return windows
}

/**
 * Assemble the ordered tmux invocations that stand up a dashboard session and the final
 * attach. Pure — takes the resolved windows and returns argv arrays — so the exact tmux
 * command sequence (window creation, activity/silence monitoring, tab styling) is
 * unit-testable without spawning tmux; the CLI just runs each.
 */
export function buildDashboardPlan(
  session: string,
  tmuxConf: string,
  windows: readonly WindowSpec[],
): DashboardPlan {
  return {
    commands: renderDashboardPlanCommands(session, tmuxConf, windows),
    attach: renderDashboardAttachCommand(session),
  }
}

async function buildLocalWindow(
  name: string,
  agent: Readonly<AgentState>,
  state: Readonly<QuimbyState>,
  repoRoot: string,
): Promise<WindowSpec> {
  const config = await loadQuimbyConfig(repoRoot)
  const { runtime, entrypoint, env: profileEnv } = resolveRuntimeSelection({ agent, config })
  const adapter = getRuntime(runtime)
  const ctx = buildContext(repoRoot, name, state.id, agent.id)
  const rawSpec = adapter.runSpec(ctx, entrypoint)
  const spec = { ...rawSpec, env: { ...profileEnv, ...(rawSpec.env ?? {}) } }

  const baseCmd = [spec.command, ...spec.args].map(sq).join(' ')
  const windowCmd = `${baseCmd}; __code=$?; [ "$__code" -eq 0 ] || { printf '\\n[quimby] agent exited with code %s — press Enter to close\\n' "$__code"; read -r _; }`

  const env = Object.entries(spec.env ?? {}).map(([k, v]) => [k, v] as [string, string])
  return {
    name,
    cwd: spec.cwd ?? repoRoot,
    rootCwd: repoRoot,
    cmd: ['bash', '-l', '-c', windowCmd],
    env: env.length > 0 ? env : undefined,
  }
}

async function buildSshWindow(
  name: string,
  agent: Readonly<AgentState>,
  loc: SSHLocation,
  state: Readonly<QuimbyState>,
  repoRoot: string,
  reporter: Reporter,
): Promise<WindowSpec> {
  const launch = await prepareSshLaunch({ state, repoRoot, agent, location: loc }, reporter)

  // The remote command creates/attaches a tmux session on the SSH host; if the SSH
  // connection drops, the remote tmux keeps the agent alive and the window can reconnect.
  const remoteTmuxArgs = [
    'tmux',
    '-L',
    quimbyTmuxSocket,
    '-f',
    launch.tmuxConf,
    'new-session',
    '-A',
    '-s',
    launch.sessionName,
    '-n',
    launch.windowName,
    '-c',
    launch.cwd,
    'bash',
    '-l',
    '-c',
    sq(launch.shellCmd),
    '\\;',
    'bind',
    'c',
    'new-window',
    '-c',
    sq(QUIMBY_ROOT_TMUX_FORMAT),
  ].join(' ')

  const sshFlags = loc.port ? ['-p', String(loc.port)] : []
  return {
    name,
    cwd: repoRoot,
    rootCwd: repoRoot,
    // launch.host is the resolved connection target (prepareSshLaunch throws on an unbound alias).
    cmd: ['ssh', '-t', ...sshFlags, launch.host, remoteTmuxArgs],
  }
}
