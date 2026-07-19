import { configureLocalAgentIdentity, writeAgentInstructions } from '@quimbyhq/agent'
import {
  getAgentDir,
  getAgentRepoDir,
  getAgentSessionLogPath,
  getTmuxConfigPath,
  quimbyTmuxSocket,
  tmuxSessionName,
} from '@quimbyhq/paths'
import { buildContext, getRuntime } from '@quimbyhq/runtimes'
import { reconcileAgentStatusMirror } from '@quimbyhq/status'
import { renderTmuxConfig } from '@quimbyhq/template'
import { sq } from '@quimbyhq/transport'
import type { AgentState, QuimbyState, RunSpec } from '@quimbyhq/types'
import { writeText } from '@quimbyhq/utils'
import { loadQuimbyConfig } from '@quimbyhq/workspace'

import { resolveRuntimeSelection } from './runtime'
import { tmuxSetQuimbyRootShell } from './tmux'

export interface LaunchOptions {
  state: QuimbyState
  repoRoot: string
  agent: Readonly<AgentState>
  cmd?: string
  runtime?: string
  runtimeProfile?: string
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
export async function buildForegroundLaunch(
  opts: Readonly<LaunchOptions>,
): Promise<ForegroundLaunch> {
  const { state, repoRoot, agent } = opts
  const config = await loadQuimbyConfig(repoRoot)
  const { runtime, entrypoint, runtimeLabel, env } = resolveRuntimeSelection({ ...opts, config })
  const adapter = getRuntime(runtime)
  const ctx = buildContext(repoRoot, agent.name, state.id, agent.id)
  const spec = adapter.runSpec(ctx, entrypoint)
  return { spec: { ...spec, env: { ...env, ...(spec.env ?? {}) } }, entrypoint, runtimeLabel }
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
  const config = await loadQuimbyConfig(repoRoot)
  const { runtime, entrypoint, runtimeLabel, env } = resolveRuntimeSelection({ ...opts, config })

  // Re-apply the git identity and refresh the Quimby-tier instruction files on every launch, so
  // fixing the host identity or shipping newer instructions reaches an existing agent without a
  // rebuild. Both idempotent and best-effort — a transient failure must never block the launch.
  try {
    await configureLocalAgentIdentity(repoRoot, getAgentRepoDir(repoRoot, agent.id), agent.name)
    await writeAgentInstructions(getAgentDir(repoRoot, agent.id), {
      agentName: agent.name,
      agentId: agent.id,
      runtime,
    })
    // Seed this agent's peer roster so `ls status/` is correct even with no server running —
    // a placeholder per current peer, orphans swept. Idempotent; the poller refreshes content.
    await reconcileAgentStatusMirror(repoRoot, state, agent.name)
  } catch {
    // Advisory; leave whatever the clone already has.
  }

  const adapter = getRuntime(runtime)
  const ctx = buildContext(repoRoot, agent.name, state.id, agent.id)
  // Validate the runtime (e.g. the sbx/openshell CLI is installed) before any tmux work, so a
  // missing runtime fails with a clear error instead of a pane that dies the instant it launches.
  await adapter.setup(ctx)
  const rawSpec = await adapter.runSpec(ctx, entrypoint)
  const spec = { ...rawSpec, env: { ...env, ...(rawSpec.env ?? {}) } }

  const envArgs = Object.entries(spec.env ?? {}).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`,
  ])

  // Run the command through a login shell so the tmux pane resolves PATH from the
  // user's profile; without it tmux execs in the tmux server's environment, which
  // may lack user-installed tools (`sbx`/`claude`), and the session exits instantly.
  const baseCmd = [spec.command, ...spec.args].map(sq).join(' ')
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
