import { QuimbyError } from '@quimbyhq/errors'
import { quimbyTmuxSocket } from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { buildContext, getRuntime } from '@quimbyhq/runtimes'
import { sq } from '@quimbyhq/transport'
import type { AgentState, QuimbyState, SSHLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'

import { resolveRuntimeSelection } from './runtime'
import { prepareSshLaunch } from './ssh'
import {
  QUIMBY_ROOT_TMUX_FORMAT,
  QUIMBY_ROOT_TMUX_OPTION,
  quimbyRootNewWindowBindingArgs,
} from './tmux'

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
        : buildLocalWindow(name, agent, state, repoRoot),
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
  const tmux = ['-L', quimbyTmuxSocket]
  const commands: string[][] = []

  const first = windows[0]
  commands.push([
    ...tmux,
    '-f',
    tmuxConf,
    'new-session',
    '-d',
    '-s',
    session,
    '-n',
    first.name,
    '-c',
    first.cwd,
    ...envArgs(first),
    ...first.cmd,
  ])
  commands.push([...tmux, ...quimbyRootNewWindowBindingArgs()])
  commands.push([
    ...tmux,
    'set-option',
    '-t',
    session,
    QUIMBY_ROOT_TMUX_OPTION,
    first.rootCwd ?? first.cwd,
  ])

  for (const w of windows.slice(1)) {
    commands.push([
      ...tmux,
      'new-window',
      '-t',
      session,
      '-n',
      w.name,
      '-c',
      w.cwd,
      ...envArgs(w),
      ...w.cmd,
    ])
  }

  // Monitoring: light up tabs when an agent finishes (silence) or resumes (activity),
  // set as session defaults so every window inherits them.
  for (const [opt, val] of MONITOR_OPTS) {
    commands.push([...tmux, 'set-option', '-t', session, opt, val])
  }
  commands.push([
    ...tmux,
    'set-option',
    '-t',
    session,
    'window-status-format',
    WINDOW_STATUS_FORMAT,
  ])
  commands.push([
    ...tmux,
    'set-option',
    '-t',
    session,
    'window-status-current-format',
    WINDOW_STATUS_CURRENT_FORMAT,
  ])
  commands.push([...tmux, 'select-window', '-t', `${session}:0`])

  return { commands, attach: [...tmux, 'attach', '-t', session] }
}

function buildLocalWindow(
  name: string,
  agent: Readonly<AgentState>,
  state: Readonly<QuimbyState>,
  repoRoot: string,
): WindowSpec {
  const { runtime, entrypoint } = resolveRuntimeSelection({ agent })
  const adapter = getRuntime(runtime)
  const ctx = buildContext(repoRoot, name, state.id, agent.id)
  const spec = adapter.runSpec(ctx, entrypoint)

  const baseCmd = [spec.command, ...spec.args.map((a) => (a === entrypoint ? sq(a) : a))].join(' ')
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
    cmd: ['ssh', '-t', ...sshFlags, loc.host, remoteTmuxArgs],
  }
}

function envArgs(window: Readonly<WindowSpec>): string[] {
  return (window.env ?? []).flatMap(([k, v]) => ['-e', `${k}=${v}`])
}

const MONITOR_OPTS: [string, string][] = [
  ['monitor-activity', 'on'],
  ['monitor-silence', '30'],
  ['visual-activity', 'off'],
  ['visual-silence', 'off'],
]

// Tmux conditional format: silence → green, activity → amber, default → grey.
const WINDOW_STATUS_FORMAT =
  '#{?window_silence_flag,#[fg=colour108]#[bold] #W ,#{?window_activity_flag,#[fg=colour214] #W ,#[fg=colour244] #W }}'
const WINDOW_STATUS_CURRENT_FORMAT = '#[fg=colour231,bg=colour238,bold] #W '
