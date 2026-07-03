import {
  getAgentSessionLogPath,
  getTmuxConfigPath,
  quimbyTmuxSocket,
  tmuxSessionName,
} from '@quimbyhq/paths'
import { buildContext, getRuntime } from '@quimbyhq/runtimes'
import { renderTmuxConfig } from '@quimbyhq/template'
import { sq } from '@quimbyhq/transport'
import type { AgentState, QuimbyState, RunSpec } from '@quimbyhq/types'
import { writeText } from '@quimbyhq/utils'

import { resolveRuntimeSelection } from './runtime'
import { tmuxSetQuimbyRootShell } from './tmux'

export interface LaunchOptions {
  state: QuimbyState
  repoRoot: string
  agent: Readonly<AgentState>
  cmd?: string
  runtime?: string
}

/**
 * Everything `run`/`start` need to open (or reattach to) a local tmux session for an
 * agent: the pieces of a `tmux … new-session` invocation. Feed to {@link localNewSessionArgs}
 * with the mode — `run` attaches, `start` creates detached.
 */
export interface LocalTmuxLaunch {
  sessionName: string
  tmuxConf: string
  cwd: string
  rootCwd: string
  envArgs: string[]
  shellCmd: string
  windowName: string
  runtimeLabel: string
}

/** A foreground (non-tmux) local launch: the runtime's spawn spec plus display bits. */
export interface ForegroundLaunch {
  spec: RunSpec
  entrypoint: string
  runtimeLabel: string
}

/**
 * Resolve the runtime spawn spec for a foreground local agent (no tmux). The CLI spawns
 * `spec.command` itself; this only decides what to run and where.
 */
export function buildForegroundLaunch(opts: Readonly<LaunchOptions>): ForegroundLaunch {
  const { state, repoRoot, agent } = opts
  const { runtime, entrypoint, runtimeLabel } = resolveRuntimeSelection(opts)
  const adapter = getRuntime(runtime)
  const ctx = buildContext(repoRoot, agent.name, state.id, agent.id)
  return { spec: adapter.runSpec(ctx, entrypoint), entrypoint, runtimeLabel }
}

/**
 * The `tmux … new-session` argv for a local launch. `run` passes `detached: false`
 * (attach, `-A`); `start` passes `detached: true` (`-A -d`, headless). Identical
 * otherwise, so both commands share this one assembly.
 */
export function localNewSessionArgs(
  launch: Readonly<LocalTmuxLaunch>,
  opts: { detached: boolean },
): string[] {
  return [
    '-L',
    quimbyTmuxSocket,
    '-f',
    launch.tmuxConf,
    'new-session',
    '-A',
    ...(opts.detached ? ['-d'] : []),
    '-s',
    launch.sessionName,
    '-n',
    launch.windowName,
    '-c',
    launch.cwd,
    ...launch.envArgs,
    'bash',
    '-l',
    '-c',
    launch.shellCmd,
  ]
}

/**
 * Prepare a local agent's tmux launch: resolve runtime/entrypoint, build the shell
 * command (window-label refresh + entrypoint, holding the pane open on failure so the
 * error is readable), and write the bundled tmux config. Does not spawn tmux — the
 * caller decides attach vs detached.
 */
export async function prepareLocalTmuxLaunch(
  opts: Readonly<LaunchOptions>,
): Promise<LocalTmuxLaunch> {
  const { state, repoRoot, agent } = opts
  const { runtime, entrypoint, runtimeLabel } = resolveRuntimeSelection(opts)

  const adapter = getRuntime(runtime)
  const ctx = buildContext(repoRoot, agent.name, state.id, agent.id)
  // Validate the runtime (e.g. the sbx/openshell CLI is installed) before any tmux work, so a
  // missing runtime fails with a clear error instead of a pane that dies the instant it launches.
  await adapter.setup(ctx)
  const spec = await adapter.runSpec(ctx, entrypoint)

  const envArgs = Object.entries(spec.env ?? {}).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`,
  ])

  // Run the command through a login shell so the tmux pane resolves PATH from the
  // user's profile; without it tmux execs in the tmux server's environment, which
  // may lack user-installed tools (`sbx`/`claude`), and the session exits instantly.
  const baseCmd = [spec.command, ...spec.args.map((a) => (a === entrypoint ? sq(a) : a))].join(' ')
  // Start a durable transcript of this pane (`quimby log --follow` tails it) — the pane
  // pipes its own output to session.log. Runs once per pane lifetime (fresh session /
  // respawn), targeting `$TMUX_PANE` so it needs no session lookup; failures are ignored.
  const logPath = getAgentSessionLogPath(repoRoot, agent.id)
  const pipeCmd = `tmux pipe-pane -t "$TMUX_PANE" ${sq(`cat >> ${sq(logPath)}`)} 2>/dev/null; `
  const rootCmd = tmuxSetQuimbyRootShell(repoRoot)
  // Refresh the window label on every (re)attach so it tracks renames, then hold the
  // pane open if the agent command fails so its error is readable instead of the
  // session vanishing with a bare "[exited]"; a clean exit closes it normally.
  const shellCmd = `${pipeCmd}${rootCmd}tmux rename-window ${sq(agent.name)} 2>/dev/null; ${baseCmd}; __code=$?; [ "$__code" -eq 0 ] || { printf '\\n[quimby] agent exited with code %s — press Enter to close\\n' "$__code"; read -r _; }`

  const tmuxConf = getTmuxConfigPath(repoRoot)
  await writeText(tmuxConf, renderTmuxConfig())

  return {
    sessionName: tmuxSessionName(agent.id),
    tmuxConf,
    cwd: spec.cwd ?? repoRoot,
    rootCwd: repoRoot,
    envArgs,
    shellCmd,
    windowName: agent.name,
    runtimeLabel,
  }
}
