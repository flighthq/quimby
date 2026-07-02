import { configureRemoteAgentIdentity } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import {
  dashboardSessionName,
  dashboardViewPrefix,
  dashboardViewSessionName,
  getQuimbyDir,
  getTmuxConfigPath,
  quimbyTmuxSocket,
  remoteAgentDir,
  remoteAgentRepoDir,
  remoteProjectRoot,
  remoteTmuxConfigPath,
  tmuxSessionName,
} from '@quimbyhq/paths'
import { getRuntime, runtimeTypes } from '@quimbyhq/runtimes'
import { renderAgentClaudeMd, renderTmuxConfig } from '@quimbyhq/template'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentState, QuimbyState, RuntimeType, SSHLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger, writeText } from '@quimbyhq/utils'
import { resolveWorkspace, saveState } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'
import { join } from 'pathe'

import { prepareLocalTmuxLaunch, prepareSshLaunch } from '../launch'
import type { LayoutNode } from '../layout'
import { collectLayoutAgents, isLayoutExpr, parseLayout } from '../layout'

export default defineCommand({
  meta: {
    name: 'run',
    description:
      'Launch an agent interactively (multiple names opens a tabbed dashboard; a layout ' +
      'expression like "a b | c d" opens a multi-panel dashboard)',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Agent name(s)',
      required: true,
    },
    cmd: {
      type: 'string',
      alias: 'c',
      description: 'Entrypoint command to launch for this run (overrides the agent default)',
    },
    runtime: {
      type: 'string',
      alias: 'r',
      description: `Runtime override for this run (${runtimeTypes.join(', ')})`,
    },
    host: {
      type: 'boolean',
      default: true,
      description: 'Include a host shell tab in the dashboard (default: true; --no-host to omit)',
    },
  },
  run: runRunCommand,
})

export async function runRunCommand({
  args,
}: {
  args: { name: string; _?: string[]; cmd?: string; runtime?: string; host?: boolean }
}) {
  // A layout expression (uses `|` `/` `(` `)`) opens a multi-panel dashboard — split panes,
  // each a tabbed view over the retained agent sessions. Purely additive: bare `run a b`
  // (no operators) stays the flat tabbed dashboard below.
  if (isLayoutExpr(args.name)) {
    if (insideQuimbyTmux()) {
      throw new QuimbyError(
        'Run a panel layout from outside a quimby session — it builds its own dashboard.',
      )
    }
    if (args.cmd || args.runtime) {
      throw new QuimbyError('--cmd/--runtime apply to a single agent; omit them for a panel layout')
    }
    await runPanelDashboard(args.name)
    return
  }

  // citty puts every positional in `args._` (including the one bound to `name`), so a
  // plain concat would duplicate the first agent — dedupe, as `sync` does.
  const names = [
    ...new Set([args.name, ...(args._ ?? [])].filter((n): n is string => Boolean(n))),
  ].filter((n) => n !== HOST_WINDOW)

  // If we're already inside the quimby dashboard, a nested `tmux attach` / `new-session -A`
  // would steal this client from the dashboard and fire its client-detached self-destruct
  // hook, tearing down every tab. Add/select the requested agents as tabs in the current
  // session instead — no attach, no teardown.
  if (names.length > 0 && insideQuimbyTmux()) {
    await attachWithinCurrentSession(names)
    return
  }

  if (names.length > 1) {
    if (args.cmd) {
      throw new QuimbyError('--cmd applies to a single agent; omit it when running multiple agents')
    }
    if (args.runtime) {
      throw new QuimbyError(
        '--runtime applies to a single agent; omit it when running multiple agents',
      )
    }
    await runDashboard(names, args.host !== false)
    return
  }

  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.name]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
  }

  // ── SSH agent ──────────────────────────────────────────────────────────────
  if (isSSH(agent.location)) {
    const launch = await prepareSshLaunch({
      state,
      repoRoot,
      agent,
      location: agent.location,
      cmd: args.cmd,
      runtime: args.runtime,
    })

    // Restore the status bar (a previous dashboard session turns it off on SSH agents).
    await launch.transport
      .exec(
        `tmux -L ${sq(quimbyTmuxSocket)} set-option -t ${sq(launch.sessionName)} status on 2>/dev/null; true`,
      )
      .catch(() => {})

    // Revive a held-dead remote pane before attaching (see the local path) so recovery is
    // always `quimby run`, never a raw tmux respawn on the remote host.
    await launch.transport
      .exec(
        `if [ "$(tmux -L ${sq(quimbyTmuxSocket)} display-message -p -t ${sq(launch.sessionName)} '#{pane_dead}' 2>/dev/null)" = 1 ]; then tmux -L ${sq(quimbyTmuxSocket)} respawn-window -k -t ${sq(launch.sessionName)}; fi 2>/dev/null; true`,
      )
      .catch(() => {})

    logger.success(
      `Attaching to tmux session "${launch.sessionName}" on ${launch.host}${launch.runtimeLabel}`,
    )
    // CWD is the agent dir (parent of repo/) so the agent sees assignment.md, inbox/,
    // etc. tmux -A attaches to an existing session or creates a new one; bash -l is a
    // login shell so PATH includes user-installed tools like claude / sbx.
    await launch.transport.runInteractive('tmux', [
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
      launch.cwd, // unquoted so the remote shell expands ~
      'bash',
      '-l',
      '-c',
      sq(launch.shellCmd),
    ])
    return
  }

  // ── Local agent (always tmux, so the session is grab-able from anywhere) ──────
  // Every agent lives in its own persistent tmux session; `new-session -A` attaches to it
  // if it is already running (started here, by `start`, or shown in a dashboard) and
  // creates it otherwise — so `quimby run <agent>` always grabs the one canonical session.
  const launch = await prepareLocalTmuxLaunch({
    state,
    repoRoot,
    agent,
    cmd: args.cmd,
    runtime: args.runtime,
  })

  // Enroll into tmux so `nudge`/`list` recognize the now-persistent session on later calls.
  if (!agent.tmux) {
    state.agents[args.name].tmux = true
    await saveState(repoRoot, state)
  }

  // Restore the status bar (a previous dashboard session turns it off on linked agents).
  await execa('tmux', [
    '-L',
    quimbyTmuxSocket,
    'set-option',
    '-t',
    launch.sessionName,
    'status',
    'on',
  ]).catch(() => {})

  // If the session is held alive but its agent has exited (a dead pane, e.g. one kept by a
  // dashboard's remain-on-exit), respawn it so `quimby run` always delivers a *running* agent
  // rather than dropping the user onto a corpse. Recovery therefore never leaves `quimby run`.
  await reviveIfDead(['-L', quimbyTmuxSocket], launch.sessionName)

  logger.success(`Attaching to tmux session "${launch.sessionName}"${launch.runtimeLabel}`)
  try {
    await execa(
      'tmux',
      [
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
        ...launch.envArgs,
        'bash',
        '-l',
        '-c',
        launch.shellCmd,
      ],
      { stdio: 'inherit' },
    )
  } catch (err) {
    const e = err as { exitCode?: number }
    if (e.exitCode !== undefined && e.exitCode !== 0) {
      process.exit(e.exitCode)
    }
  }
}

// ── Dashboard mode ────────────────────────────────────────────────────────────
// Multiple agents → one tmux "dashboard" session, one tab per agent. The dashboard is
// only a viewport: each agent runs in its OWN persistent tmux session — a local agent in
// a detached per-agent session linked in with `link-window`, an SSH agent in its remote
// session reached by an ssh-attach window. So closing or rebuilding the dashboard never
// kills an agent; the per-agent sessions outlive it and `nudge`/`list` address them
// directly. The reserved name "host" adds a "$" shell tab in the repo root.

const HOST_WINDOW = 'host'
const HOST_TAB_NAME = '$'
const DASH_PLACEHOLDER = '__quimby__'

// A host shell slot is written either as the reserved word `host` or the `$` layout token;
// both open a plain login shell in the repo root, and either may appear more than once.
function isHostToken(name: string): boolean {
  return name === HOST_WINDOW || name === HOST_TAB_NAME
}

// Tab-bar formats, shared by the dashboard build and the within-dashboard `run` jump. Color
// tracks *attention*, not just state: an agent going quiet (silence → settled, likely waiting
// on you) is the notable event, so it gets green-bold; ongoing work is normal, so activity
// gets the calm quimby-blue accent rather than an alarming amber; idle is grey; a dead agent
// (process exited, pane held by remain-on-exit) is red so it reads as "stopped", not a glitch.
const AGENT_WINDOW_FMT =
  '#{?pane_dead,#[fg=colour174]#[bold] ✗ #W ,#{?window_silence_flag,#[fg=colour108]#[bold] #W ,#{?window_activity_flag,#[fg=colour109] #W ,#[fg=colour244] #W }}}'
const HOST_WINDOW_FMT =
  '#{?window_silence_flag,#[fg=colour108]#[bold] #W ,#{?window_activity_flag,#[fg=colour109] #W ,#[fg=colour248] #W }}'
const CURRENT_WINDOW_FMT = '#[fg=colour231,bg=colour238,bold] #W '

interface WindowSpec {
  name: string
  cwd: string
  cmd: string[]
  env?: [string, string][]
}

// A dashboard tab is either a window LINKED from an agent's own session (local agents, so
// the session persists past the dashboard) or a normal window running a command (an SSH
// attach, or the host shell).
type DashboardTab =
  | { name: string; kind: 'link'; srcSession: string }
  | { name: string; kind: 'window'; cwd: string; cmd: string[]; env?: [string, string][] }

async function runDashboard(names: string[], includeHost: boolean): Promise<void> {
  const { state, repoRoot } = await resolveWorkspace()

  for (const name of names) {
    if (!state.agents[name]) {
      throw new QuimbyError(`Agent "${name}" not found`)
    }
  }

  const TMUX = ['-L', quimbyTmuxSocket]
  const tmuxConf = getTmuxConfigPath(repoRoot)
  await writeText(tmuxConf, renderTmuxConfig())

  // Resolve each requested tab, ensuring a local agent has its own live session first so
  // the dashboard can link (not own) it. The host shell tab is prepended automatically
  // unless --no-host was passed.
  const tabs: DashboardTab[] = []
  if (includeHost) {
    tabs.push({ name: HOST_TAB_NAME, kind: 'window', cwd: repoRoot, cmd: ['bash', '-l'] })
  }
  let enrolled = false
  for (const name of names) {
    const agent = state.agents[name]
    if (isSSH(agent.location)) {
      const w = await buildSSHWindow(name, agent, state, repoRoot)
      tabs.push({ name: w.name, kind: 'window', cwd: w.cwd, cmd: w.cmd, env: w.env })
    } else {
      const srcSession = await ensureLocalAgentSession({ state, repoRoot, agent }, TMUX)
      // Enroll the agent into tmux so `nudge`/`list` recognize its now-persistent session.
      if (!agent.tmux) {
        state.agents[name].tmux = true
        enrolled = true
      }
      tabs.push({ name, kind: 'link', srcSession })
    }
  }
  if (enrolled) await saveState(repoRoot, state)

  const session = dashboardSessionName(state.id)

  // The dashboard owns no state (the agent sessions are separate), so tear down any stale
  // one and rebuild: this always reflects the requested set and sidesteps tmux's
  // "duplicate session" error on a re-run. A throwaway placeholder window seeds the
  // session so the first real tab can be appended in order.
  await execa('tmux', [...TMUX, 'kill-session', '-t', session]).catch(() => {})
  await execa('tmux', [
    ...TMUX,
    '-f',
    tmuxConf,
    'new-session',
    '-d',
    '-s',
    session,
    '-n',
    DASH_PLACEHOLDER,
    '-c',
    repoRoot,
  ])

  for (const tab of tabs) {
    if (tab.kind === 'link') {
      await execa('tmux', [
        ...TMUX,
        'link-window',
        '-a',
        '-s',
        `${tab.srcSession}:${tab.name}`,
        '-t',
        `${session}:`,
      ])
    } else {
      const envArgs = (tab.env ?? []).flatMap(([k, v]) => ['-e', `${k}=${v}`])
      await execa('tmux', [
        ...TMUX,
        'new-window',
        '-a',
        '-t',
        `${session}:`,
        '-n',
        tab.name,
        '-c',
        tab.cwd,
        ...envArgs,
        ...tab.cmd,
      ])
    }
  }
  await execa('tmux', [...TMUX, 'kill-window', '-t', `${session}:${DASH_PLACEHOLDER}`]).catch(
    () => {},
  )

  await styleDashboard(TMUX, session, tabs)

  logger.success(`Dashboard "${session}" — ${names.join(', ')}`)

  try {
    await execa('tmux', [...TMUX, 'attach', '-t', session], { stdio: 'inherit' })
  } catch (err) {
    const e = err as { exitCode?: number }
    if (e.exitCode !== undefined && e.exitCode !== 0) {
      process.exit(e.exitCode)
    }
  }
}

// True when this process runs inside a client of quimby's own tmux server (socket -L quimby),
// i.e. inside a `quimby run` / dashboard session. $TMUX is "<socketPath>,<pid>,<session>"; the
// socket's basename is the -L name. A nested attach here must be avoided (see the caller).
function insideQuimbyTmux(): boolean {
  const tmux = process.env.TMUX
  if (!tmux) return false
  const socketPath = tmux.split(',')[0]
  return socketPath.slice(socketPath.lastIndexOf('/') + 1) === quimbyTmuxSocket
}

// Respawn an agent whose session is alive but whose process has exited (a dead pane held open
// by remain-on-exit). respawn-window -k replays the exact command quimby launched the pane
// with, so reviving stays inside quimby's launch path — the user never reconstructs it. The
// pane_dead guard is essential: it means a *live* agent is left untouched (never restarted out
// from under running work). A no-op when the session is absent (display-message throws) or the
// pane is alive.
async function reviveIfDead(tmux: string[], session: string): Promise<void> {
  const dead = await execa('tmux', [
    ...tmux,
    'display-message',
    '-p',
    '-t',
    session,
    '#{pane_dead}',
  ])
    .then((r) => r.stdout.trim() === '1')
    .catch(() => false)
  if (dead) {
    await execa('tmux', [...tmux, 'respawn-window', '-k', '-t', session]).catch(() => {})
  }
}

// Add the requested agents to the current dashboard session as tabs, then select the last
// one — the safe in-dashboard equivalent of `quimby run <agent>`. It never attaches (we are
// already attached) and never kills a session, so it can't trip the dashboard's
// client-detached self-destruct hook the way a nested attach did. An agent already present is
// just selected; a local agent is linked from its own (ensured) session, an SSH agent gets a
// fresh ssh-attach window. A per-run --cmd/--runtime is intentionally ignored here: the tab
// links the agent's canonical session, which those flags don't reshape once it exists.
async function attachWithinCurrentSession(names: string[]): Promise<void> {
  const { state, repoRoot } = await resolveWorkspace()
  for (const name of names) {
    if (!state.agents[name]) {
      throw new QuimbyError(`Agent "${name}" not found`)
    }
  }

  const TMUX = ['-L', quimbyTmuxSocket]
  const session = (
    await execa('tmux', [...TMUX, 'display-message', '-p', '#{session_name}'])
  ).stdout.trim()
  const { stdout: winList } = await execa('tmux', [
    ...TMUX,
    'list-windows',
    '-t',
    session,
    '-F',
    '#{window_name}',
  ])
  const existing = new Set(winList.split('\n').filter(Boolean))

  let enrolled = false
  let selected: string | null = null
  for (const name of names) {
    const agent = state.agents[name]
    if (existing.has(name)) {
      // Already a tab: revive its underlying session if the agent has exited, so selecting the
      // tab lands on a running agent (SSH tabs are ssh-attach windows, revived on reconnect).
      if (!isSSH(agent.location)) await reviveIfDead(TMUX, tmuxSessionName(agent.id))
    } else {
      if (isSSH(agent.location)) {
        const w = await buildSSHWindow(name, agent, state, repoRoot)
        const envArgs = (w.env ?? []).flatMap(([k, v]) => ['-e', `${k}=${v}`])
        await execa('tmux', [...TMUX, 'new-window', '-a', '-t', `${session}:`, '-n', w.name, '-c', w.cwd, ...envArgs, ...w.cmd]) // prettier-ignore
      } else {
        const srcSession = await ensureLocalAgentSession({ state, repoRoot, agent }, TMUX)
        if (!agent.tmux) {
          state.agents[name].tmux = true
          enrolled = true
        }
        await execa('tmux', [...TMUX, 'link-window', '-a', '-s', `${srcSession}:${name}`, '-t', `${session}:`]) // prettier-ignore
      }
      await styleAgentTab(TMUX, `${session}:${name}`)
    }
    selected = name
  }
  if (enrolled) await saveState(repoRoot, state)
  if (selected) {
    await execa('tmux', [...TMUX, 'select-window', '-t', `${session}:${selected}`]).catch(() => {})
  }
  logger.success(`Added to dashboard "${session}": ${names.join(', ')}`)
}

// Ensure a local agent has its own detached tmux session (identical to `quimby start`),
// so the dashboard can link its window in without owning the agent's lifecycle. Idempotent:
// an already-running session is reused, so a re-run never restarts the agent. Returns the
// session name to link from.
async function ensureLocalAgentSession(
  opts: Readonly<{ state: QuimbyState; repoRoot: string; agent: Readonly<AgentState> }>,
  tmux: string[],
): Promise<string> {
  const launch = await prepareLocalTmuxLaunch(opts)
  const running = await execa('tmux', [...tmux, 'has-session', '-t', launch.sessionName]).then(
    () => true,
    () => false,
  )
  if (running) {
    // Reused session: revive it if the agent has exited, so a linked tab shows a running
    // agent rather than a corpse — the dashboard/jump equivalent of `quimby run`'s revive.
    await reviveIfDead(tmux, launch.sessionName)
  } else {
    await execa('tmux', [
      ...tmux,
      '-f',
      launch.tmuxConf,
      'new-session',
      '-d',
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
    ])
  }
  return launch.sessionName
}

async function buildSSHWindow(
  name: string,
  agent: AgentState,
  state: QuimbyState,
  repoRoot: string,
): Promise<WindowSpec> {
  const loc = agent.location as SSHLocation
  const transport = getSSHTransport(loc)
  const rRoot = remoteProjectRoot(state.id, loc.base)
  const rAgentDir = remoteAgentDir(state.id, agent.id, loc.base)
  const rRepoDir = remoteAgentRepoDir(state.id, agent.id, loc.base)

  logger.start(`Syncing project to ${loc.host} for "${name}"...`)
  await transport.syncProjectTo(repoRoot, rRoot)

  const rLegacyAgentDir = remoteAgentDir(state.id, name, loc.base)
  if (rLegacyAgentDir !== rAgentDir) {
    await transport.exec(
      `if [ -d ${rLegacyAgentDir} ] && [ ! -d ${rAgentDir} ]; then mkdir -p "$(dirname ${rAgentDir})" && mv ${rLegacyAgentDir} ${rAgentDir}; fi`,
    )
  }

  const repoReady = await transport.fileExists(`${rRepoDir}/.git`)
  if (!repoReady) {
    await transport.checkCapabilities(['git', 'rsync', 'tmux'])
    logger.start(`Initializing remote agent "${name}"...`)
    await transport.ensureDir(`${rAgentDir}/inbox/status`)
    await transport.ensureDir(`${rAgentDir}/outbox`)
    await transport.exec(`git clone ${rRoot} ${rRepoDir}`)
    await transport.exec(`git tag quimby/seed`, { cwd: rRepoDir })
    await configureRemoteAgentIdentity(transport, rRepoDir, name, repoRoot)
    const seedCommit = (await transport.exec(`git rev-parse HEAD`, { cwd: rRepoDir })).trim()
    await transport.writeFile(`${rAgentDir}/assignment.md`, '')
    await transport.writeFile(`${rAgentDir}/status.md`, 'idle')
    const claudeMd = renderAgentClaudeMd({ agentName: name, agentId: agent.id })
    await transport.writeFile(`${rAgentDir}/CLAUDE.md`, claudeMd)

    state.agents[name].seedCommit = seedCommit
    await saveState(repoRoot, state)
    logger.success(`Remote agent "${name}" initialized`)
  }

  const runtime = (agent.defaults?.runtime as RuntimeType | undefined) ?? 'local'
  const entrypoint = agent.defaults?.entrypoint ?? 'claude'

  if (!runtimeTypes.includes(runtime)) {
    throw new QuimbyError(
      `Agent "${name}": unknown runtime "${runtime}". Available: ${runtimeTypes.join(', ')}`,
    )
  }

  const adapter = getRuntime(runtime)
  const spec = await adapter.runSpec(
    {
      projectId: state.id,
      agentId: agent.id,
      agentName: name,
      agentDir: rAgentDir,
      repoDir: rRepoDir,
      repoRoot: rRoot,
    },
    entrypoint,
  )

  const launchCmd = [spec.command, ...spec.args.map((a) => (a === entrypoint ? sq(a) : a))].join(
    ' ',
  )

  // Write the remote tmux config (for the nested remote session).
  const rTmuxConf = remoteTmuxConfigPath(state.id, loc.base)
  await transport.writeFile(rTmuxConf, renderTmuxConfig())

  const remoteSession = tmuxSessionName(agent.id)
  // The remote command creates/attaches a tmux session on the SSH host.
  // The dashboard window SSHes in and attaches — if the SSH connection drops,
  // the remote tmux keeps the agent alive; the window can reconnect.
  const remoteTmuxArgs = [
    'tmux',
    '-L',
    quimbyTmuxSocket,
    '-f',
    rTmuxConf,
    'new-session',
    '-A',
    '-s',
    remoteSession,
    '-n',
    name,
    '-c',
    rAgentDir,
    'bash',
    '-l',
    '-c',
    sq(launchCmd),
    '\\;',
    'set',
    'status',
    'off',
  ].join(' ')

  const sshFlags: string[] = []
  if (loc.port) {
    sshFlags.push('-p', String(loc.port))
  }

  return {
    name,
    cwd: repoRoot,
    cmd: ['ssh', '-t', ...sshFlags, loc.host, remoteTmuxArgs],
  }
}

// ── Dashboard styling ─────────────────────────────────────────────────────────
// Everything below is applied ONLY to the dashboard session — none of it touches
// the bundled tmux config or individual agent sessions. Keybindings (`bind`) are
// server-global (tmux has no session-scoped binds), but they are harmless on
// single-window agent sessions and are set here so the intent is clear.

// Style an agent tab and make it outlive the agent's exit. `remain-on-exit on` holds the pane
// open as a [dead] pane instead of closing the window — which, since a local agent tab is a
// LINKED window shared with the agent's own session, would otherwise remove the tab from every
// session at once (the "disappearing tab"). A dead tab is revived in place with the dashboard's
// restart key (respawn-window).
async function styleAgentTab(TMUX: string[], target: string): Promise<void> {
  await execa('tmux', [...TMUX, 'set-window-option', '-t', target, 'window-status-format', AGENT_WINDOW_FMT]) // prettier-ignore
  await execa('tmux', [...TMUX, 'set-window-option', '-t', target, 'window-status-current-format', CURRENT_WINDOW_FMT]) // prettier-ignore
  await execa('tmux', [...TMUX, 'set-window-option', '-t', target, 'remain-on-exit', 'on']).catch(() => {}) // prettier-ignore
}

async function styleDashboard(
  TMUX: string[],
  session: string,
  tabs: Readonly<DashboardTab[]>,
): Promise<void> {
  // Suppress the status bar on per-agent sessions — the dashboard's own bar is sufficient,
  // and SSH tabs (which nest a remote tmux) would otherwise show a double status bar.
  for (const tab of tabs) {
    if (tab.kind === 'link') {
      await execa('tmux', [...TMUX, 'set-option', '-t', tab.srcSession, 'status', 'off']).catch(
        () => {},
      )
    }
  }

  // Number the tabs from 0 so `Ctrl-b 0/1/…` lines up with what you see; the placeholder
  // left a gap at index 0, so renumber once the real tabs are in. base-index/renumber are
  // session options — isolated to the dashboard, never touching an agent's own session.
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'base-index', '0'])
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'renumber-windows', 'on'])
  await execa('tmux', [...TMUX, 'move-window', '-r', '-t', session])
  // The dashboard is ephemeral — destroy it when the user detaches. A hook is used
  // instead of `destroy-unattached` because the session is created detached (`-d`) and
  // `destroy-unattached` would fire immediately (zero clients = already unattached).
  // Linked windows survive in their own agent sessions.
  await execa('tmux', [...TMUX, 'set-hook', '-t', session, 'client-detached', 'kill-session'])

  // ── Host tab: auto-rename with "$" prefix ───────────────────────────────────
  // The bundled tmux config disables auto-rename globally to keep agent window names
  // stable; this per-window override only affects the host tab so it shows the running
  // command (e.g. "$ bash", "$ quimby").
  const hostIdx = tabs.findIndex((t) => t.name === HOST_TAB_NAME)
  if (hostIdx !== -1) {
    const target = `${session}:${hostIdx}`
    await execa('tmux', [...TMUX, 'set-window-option', '-t', target, 'automatic-rename', 'on'])
    await execa('tmux', [
      ...TMUX,
      'set-window-option',
      '-t',
      target,
      'automatic-rename-format',
      '$ #{pane_current_command}',
    ])
  }

  // ── Activity / silence highlights ───────────────────────────────────────────
  // Light a tab when its agent goes quiet (silence → settled) or resumes (activity).
  // Silence starts disabled; hooks arm it per-window on activity and disarm after it
  // fires once — one green flash per activity burst, no re-triggering on idle windows.
  await execa('tmux', [...TMUX, 'set-window-option', '-g', 'monitor-activity', 'on'])
  await execa('tmux', [...TMUX, 'set-window-option', '-g', 'monitor-silence', '0'])
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'activity-action', 'none'])
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'silence-action', 'none'])
  await execa('tmux', [
    ...TMUX,
    'set-hook',
    '-g',
    'alert-activity',
    'set-window-option monitor-silence 30',
  ])
  await execa('tmux', [
    ...TMUX,
    'set-hook',
    '-g',
    'alert-silence',
    'set-window-option monitor-silence 0',
  ])

  // ── Tab bar formatting ──────────────────────────────────────────────────────
  // Dead → red, activity → amber, silence → green, idle → grey (lighter for the host tab).
  // Agent tabs also get remain-on-exit (via styleAgentTab) so an exit leaves a dead tab
  // rather than deleting the shared linked window; the host tab closes normally on exit.
  const { stdout: winIdx } = await execa('tmux', [
    ...TMUX,
    'list-windows',
    '-t',
    session,
    '-F',
    '#{window_index}',
  ])
  for (const idx of winIdx.split('\n').filter(Boolean)) {
    const target = `${session}:${idx}`
    if (Number(idx) === hostIdx) {
      await execa('tmux', [...TMUX, 'set-window-option', '-t', target, 'window-status-format', HOST_WINDOW_FMT]) // prettier-ignore
      await execa('tmux', [...TMUX, 'set-window-option', '-t', target, 'window-status-current-format', CURRENT_WINDOW_FMT]) // prettier-ignore
    } else {
      await styleAgentTab(TMUX, target)
    }
  }

  // ── Status bar hint + keybindings ───────────────────────────────────────────
  // Session-scoped status-right with a shortcut hint; replaces the default date/time.
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'status-right-length', '80'])
  await execa('tmux', [
    ...TMUX,
    'set-option',
    '-t',
    session,
    'status-right',
    '#[fg=colour240]alt+←→ tabs · ^b r restart · ^b d exit  #[fg=colour245]%H:%M ',
  ])
  // Alt+arrow and Alt+number tab switching (no prefix key). These are server-global
  // but harmless on single-window agent sessions — set here so they are clearly
  // dashboard-only intent and only present while a dashboard has been created.
  await execa('tmux', [...TMUX, 'bind', '-n', 'M-Left', 'previous-window'])
  await execa('tmux', [...TMUX, 'bind', '-n', 'M-Right', 'next-window'])
  for (let i = 1; i <= 9; i++) {
    await execa('tmux', [...TMUX, 'bind', '-n', `M-${i}`, 'select-window', '-t', `:${i - 1}`])
  }
  // Restart a stopped (or running) agent in its tab: respawn-window re-runs the tab's original
  // command in place, reviving a dead pane. Bound under the prefix (not a bare key) so it can't
  // fire by accident and kill a live agent.
  await execa('tmux', [...TMUX, 'bind', 'r', 'respawn-window', '-k']).catch(() => {})
  // Banner shown inside a dead agent pane so the exit reads as a status, not a freeze
  // (tmux ≥ 3.4; a no-op on older tmux, hence the catch).
  await execa('tmux', [...TMUX, 'set-option', '-g', 'remain-on-exit-format', '[quimby] #{window_name} exited (status #{pane_dead_status}) — <prefix> r restarts it']).catch(() => {}) // prettier-ignore

  // Select the first tab.
  await execa('tmux', [...TMUX, 'select-window', '-t', `${session}:0`])
}

// ── Panel dashboard mode ────────────────────────────────────────────────────────
// A layout expression (`quimby run "a b | c d"`) opens a THREE-layer nesting (see
// design-decisions.md): each agent is its own retained session (unchanged); each tab group
// is an ephemeral "view" session that link-windows those agents (exactly the flat dashboard
// above, minus the attach); and the wrapper session `D` splits its one window into panes,
// each pane nesting-attaching a view. `D` grabs no prefix (C-b passes to the tab layer);
// pane nav is on root chords + mouse; and any child's death bubbles up to tear the whole
// ephemeral group down (agents survive), so orphaned views are impossible.

async function runPanelDashboard(expr: string): Promise<void> {
  const layout = parseLayout(expr) // throws QuimbyError on malformed input
  const { state, repoRoot } = await resolveWorkspace()

  for (const name of collectLayoutAgents(layout)) {
    if (!isHostToken(name) && !state.agents[name]) {
      throw new QuimbyError(`Agent "${name}" not found`)
    }
  }

  const TMUX = ['-L', quimbyTmuxSocket]
  const tmuxConf = getTmuxConfigPath(repoRoot)
  await writeText(tmuxConf, renderTmuxConfig())

  // Each leaf (tab group) becomes one ephemeral view session, indexed in tree order.
  const leaves = collectLeaves(layout)
  const viewOf = new Map<LayoutNode, string>()
  let enrolled = false
  for (let i = 0; i < leaves.length; i++) {
    const view = dashboardViewSessionName(state.id, i)
    viewOf.set(leaves[i], view)
    if (await buildViewSession(TMUX, tmuxConf, view, leaves[i].names, state, repoRoot)) {
      enrolled = true
    }
  }
  if (enrolled) await saveState(repoRoot, state)

  // Bubble-up teardown, written to disk to avoid a nested-quoting nightmare in the pane
  // command. It sweeps the view group by name prefix, then kills the wrapper LAST; it is
  // always invoked detached (`run-shell -b`) so it survives its own host pane dying.
  const teardownPath = join(getQuimbyDir(repoRoot), 'panel-teardown.sh')
  await writeText(teardownPath, PANEL_TEARDOWN_SH)
  const viewPrefix = dashboardViewPrefix(state.id)
  const dash = dashboardSessionName(state.id)
  const teardown = `tmux -L ${quimbyTmuxSocket} run-shell -b "sh '${teardownPath}' '${quimbyTmuxSocket}' '${viewPrefix}' '${dash}'"`

  // Rebuild the wrapper from scratch (it owns no durable state; the views/agents are separate).
  await execa('tmux', [...TMUX, 'kill-session', '-t', dash]).catch(() => {})
  await execa('tmux', [...TMUX, '-f', tmuxConf, 'new-session', '-d', '-s', dash, '-c', repoRoot])
  const { stdout: firstPaneOut } = await execa('tmux', [...TMUX, 'list-panes', '-t', dash, '-F', '#{pane_id}']) // prettier-ignore
  const firstPane = firstPaneOut.split('\n').filter(Boolean)[0]

  // A leaf pane clears $TMUX (or tmux refuses to nest and the pane dies instantly), attaches
  // its view, and on return fires the detached teardown so any exit collapses the group.
  const leafCmd = (node: Readonly<LayoutNode>): string =>
    `TMUX= tmux -L ${quimbyTmuxSocket} attach -t ${viewOf.get(node)}; ${teardown}`
  await layoutInto(TMUX, layout, firstPane, repoRoot, leafCmd)

  await stylePanelDashboard(TMUX, dash, teardown)
  logger.success(`Panel dashboard "${dash}" — ${expr}`)

  try {
    await execa('tmux', [...TMUX, 'attach', '-t', dash], { stdio: 'inherit' })
  } catch (err) {
    const e = err as { exitCode?: number }
    if (e.exitCode !== undefined && e.exitCode !== 0) process.exit(e.exitCode)
  }
}

// Leaf (tab-group) nodes in tree (left-to-right / top-to-bottom) order.
function collectLeaves(node: Readonly<LayoutNode>): Extract<LayoutNode, { type: 'tabs' }>[] {
  const out: Extract<LayoutNode, { type: 'tabs' }>[] = []
  const walk = (n: Readonly<LayoutNode>): void => {
    if (n.type === 'tabs') out.push(n)
    else for (const c of n.children) walk(c)
  }
  walk(node)
  return out
}

// Recursively split `paneId` to realize `node`'s geometry, giving each leaf its command.
// A k-way split peels the first child into the current pane and the remaining (k-1) into a
// new pane sized (k-1)/k, recursively — which yields evenly-sized panes.
async function layoutInto(
  TMUX: string[],
  node: Readonly<LayoutNode>,
  paneId: string,
  cwd: string,
  leafCmd: (n: Readonly<LayoutNode>) => string,
): Promise<void> {
  if (node.type === 'tabs') {
    await execa('tmux', [...TMUX, 'respawn-pane', '-k', '-t', paneId, 'sh', '-c', leafCmd(node)])
    return
  }
  const dir = node.type === 'cols' ? '-h' : '-v'
  const children = node.children
  let cur = paneId
  for (let i = 0; i < children.length; i++) {
    if (i < children.length - 1) {
      const restPct = Math.round(((children.length - 1 - i) / (children.length - i)) * 100)
      const { stdout } = await execa('tmux', [...TMUX, 'split-window', dir, '-d', '-t', cur, '-l', `${restPct}%`, '-c', cwd, '-P', '-F', '#{pane_id}']) // prettier-ignore
      const restPane = stdout.trim()
      await layoutInto(TMUX, children[i], cur, cwd, leafCmd)
      cur = restPane
    } else {
      await layoutInto(TMUX, children[i], cur, cwd, leafCmd)
    }
  }
}

// Build one ephemeral tab-group ("view") session: link each local agent's window in, add SSH
// / host tabs, style the tab strip, and leave its status bar ON (this is the per-pane strip)
// with C-b as its prefix (the tab layer owns the prefix). Returns whether it enrolled a new
// agent into tmux. This mirrors the flat dashboard's tab loop, but produces a named session
// to be nested rather than attached.
async function buildViewSession(
  TMUX: string[],
  tmuxConf: string,
  session: string,
  names: readonly string[],
  state: QuimbyState,
  repoRoot: string,
): Promise<boolean> {
  await execa('tmux', [...TMUX, 'kill-session', '-t', session]).catch(() => {})
  await execa('tmux', [...TMUX, '-f', tmuxConf, 'new-session', '-d', '-s', session, '-n', DASH_PLACEHOLDER, '-c', repoRoot]) // prettier-ignore

  let enrolled = false
  for (const name of names) {
    if (isHostToken(name)) {
      await execa('tmux', [...TMUX, 'new-window', '-a', '-t', `${session}:`, '-n', HOST_TAB_NAME, '-c', repoRoot, 'bash', '-l']) // prettier-ignore
    } else {
      const agent = state.agents[name]
      if (isSSH(agent.location)) {
        const w = await buildSSHWindow(name, agent, state, repoRoot)
        const envArgs = (w.env ?? []).flatMap(([k, v]) => ['-e', `${k}=${v}`])
        await execa('tmux', [...TMUX, 'new-window', '-a', '-t', `${session}:`, '-n', w.name, '-c', w.cwd, ...envArgs, ...w.cmd]) // prettier-ignore
      } else {
        const srcSession = await ensureLocalAgentSession({ state, repoRoot, agent }, TMUX)
        if (!agent.tmux) {
          state.agents[name].tmux = true
          enrolled = true
        }
        await execa('tmux', [...TMUX, 'link-window', '-a', '-s', `${srcSession}:${name}`, '-t', `${session}:`]) // prettier-ignore
      }
    }
  }
  await execa('tmux', [...TMUX, 'kill-window', '-t', `${session}:${DASH_PLACEHOLDER}`]).catch(() => {}) // prettier-ignore

  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'base-index', '0'])
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'renumber-windows', 'on'])
  await execa('tmux', [...TMUX, 'move-window', '-r', '-t', session]).catch(() => {})
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'status', 'on'])
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'prefix', 'C-b'])

  const { stdout: winList } = await execa('tmux', [...TMUX, 'list-windows', '-t', session, '-F', '#{window_index} #{window_name}']) // prettier-ignore
  for (const line of winList.split('\n').filter(Boolean)) {
    const idx = line.slice(0, line.indexOf(' '))
    const wname = line.slice(line.indexOf(' ') + 1)
    const target = `${session}:${idx}`
    if (wname === HOST_TAB_NAME) {
      await execa('tmux', [...TMUX, 'set-window-option', '-t', target, 'window-status-format', HOST_WINDOW_FMT]) // prettier-ignore
      await execa('tmux', [...TMUX, 'set-window-option', '-t', target, 'window-status-current-format', CURRENT_WINDOW_FMT]) // prettier-ignore
      await execa('tmux', [...TMUX, 'set-window-option', '-t', target, 'automatic-rename', 'on'])
      await execa('tmux', [...TMUX, 'set-window-option', '-t', target, 'automatic-rename-format', '$ #{pane_current_command}']) // prettier-ignore
    } else {
      await styleAgentTab(TMUX, target)
    }
  }
  await execa('tmux', [...TMUX, 'select-window', '-t', `${session}:0`]).catch(() => {})
  return enrolled
}

// Style the wrapper: invisible (status off), grabs no prefix (C-b flows to the tab layer),
// pane nav on root chords + mouse, and a detached bubble-up teardown on detach so leaving
// the dashboard sweeps every ephemeral view (agents survive). The pane-nav binds are
// server-global but re-set on each run, so they reflect the current dashboard's intent.
async function stylePanelDashboard(TMUX: string[], dash: string, teardown: string): Promise<void> {
  await execa('tmux', [...TMUX, 'set-option', '-t', dash, 'status', 'off'])
  await execa('tmux', [...TMUX, 'set-option', '-t', dash, 'prefix', 'None'])
  await execa('tmux', [...TMUX, 'set-option', '-t', dash, 'mouse', 'on'])
  await execa('tmux', [...TMUX, 'bind', '-n', 'M-Left', 'select-pane', '-L'])
  await execa('tmux', [...TMUX, 'bind', '-n', 'M-Right', 'select-pane', '-R'])
  await execa('tmux', [...TMUX, 'bind', '-n', 'M-Up', 'select-pane', '-U'])
  await execa('tmux', [...TMUX, 'bind', '-n', 'M-Down', 'select-pane', '-D'])
  await execa('tmux', [...TMUX, 'bind', '-n', 'M-z', 'resize-pane', '-Z']).catch(() => {})

  // Highlight a pane's tab strip when its agent goes quiet/active (global, mirrors the flat
  // dashboard). The strips live on the inner view sessions; these hooks drive them.
  await execa('tmux', [...TMUX, 'set-window-option', '-g', 'monitor-activity', 'on'])
  await execa('tmux', [...TMUX, 'set-window-option', '-g', 'monitor-silence', '0'])
  await execa('tmux', [...TMUX, 'set-hook', '-g', 'alert-activity', 'set-window-option monitor-silence 30']) // prettier-ignore
  await execa('tmux', [...TMUX, 'set-hook', '-g', 'alert-silence', 'set-window-option monitor-silence 0']) // prettier-ignore

  // Detaching the wrapper (e.g. C-b d in a pane collapses inward to here) sweeps the group.
  // run-shell -b so the sweep outlives the wrapper it is about to kill.
  await execa('tmux', [...TMUX, 'set-hook', '-t', dash, 'client-detached', teardown])
}

// Bubble-up teardown, args: <socket> <view-prefix> <wrapper-session>. Kills every ephemeral
// view (matched by prefix) first, then the wrapper LAST so the sweep is never aborted by its
// own host dying. Agents live under a different namespace, so they are never matched.
const PANEL_TEARDOWN_SH = `sock="$1"; prefix="$2"; dash="$3"
for s in $(tmux -L "$sock" list-sessions -F '#{session_name}' 2>/dev/null | grep "^$prefix"); do
  tmux -L "$sock" kill-session -t "$s" 2>/dev/null
done
tmux -L "$sock" kill-session -t "$dash" 2>/dev/null
`
