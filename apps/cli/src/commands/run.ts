import { configureRemoteAgentIdentity } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import {
  dashboardSessionName,
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

import { prepareLocalTmuxLaunch, prepareSshLaunch } from '../launch'

export default defineCommand({
  meta: {
    name: 'run',
    description: 'Launch an agent interactively (multiple names opens a tabbed dashboard)',
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
  },
  run: runRunCommand,
})

export async function runRunCommand({
  args,
}: {
  args: { name: string; _?: string[]; cmd?: string; runtime?: string }
}) {
  // citty puts every positional in `args._` (including the one bound to `name`), so a
  // plain concat would duplicate the first agent — dedupe, as `sync` does.
  const names = [...new Set([args.name, ...(args._ ?? [])].filter((n): n is string => Boolean(n)))]

  if (names.length > 1) {
    if (args.cmd) {
      throw new QuimbyError('--cmd applies to a single agent; omit it when running multiple agents')
    }
    if (args.runtime) {
      throw new QuimbyError(
        '--runtime applies to a single agent; omit it when running multiple agents',
      )
    }
    await runDashboard(names)
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
// directly. The reserved name "host" adds a plain login-shell window in the repo root.

const HOST_WINDOW = 'host'
const DASH_PLACEHOLDER = '__quimby__'

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

async function runDashboard(names: string[]): Promise<void> {
  const { state, repoRoot } = await resolveWorkspace()

  for (const name of names) {
    if (name !== HOST_WINDOW && !state.agents[name]) {
      throw new QuimbyError(`Agent "${name}" not found`)
    }
  }

  const TMUX = ['-L', quimbyTmuxSocket]
  const tmuxConf = getTmuxConfigPath(repoRoot)
  await writeText(tmuxConf, renderTmuxConfig())

  // Resolve each requested tab, ensuring a local agent has its own live session first so
  // the dashboard can link (not own) it.
  const tabs: DashboardTab[] = []
  let enrolled = false
  for (const name of names) {
    if (name === HOST_WINDOW) {
      tabs.push({ name: HOST_WINDOW, kind: 'window', cwd: repoRoot, cmd: ['bash', '-l'] })
      continue
    }
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

  // Number the tabs from 0 so `Ctrl-b 0/1/…` lines up with what you see; the placeholder
  // left a gap at index 0, so renumber once the real tabs are in. base-index/renumber are
  // session options — isolated to the dashboard, never touching an agent's own session.
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'base-index', '0'])
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'renumber-windows', 'on'])
  await execa('tmux', [...TMUX, 'move-window', '-r', '-t', session])

  // Light a tab when its agent goes quiet (silence → settled) or resumes (activity).
  // monitor-activity/-silence are WINDOW options, so `set-option -t <session>` only reaches
  // the current window — set them per tab so every one reacts. On a linked local window the
  // flag is shared with the agent's own session, but that's invisible there: its plain
  // window-status-format doesn't react and visual-* stay off (set below).
  const { stdout: winIdx } = await execa('tmux', [
    ...TMUX,
    'list-windows',
    '-t',
    session,
    '-F',
    '#{window_index}',
  ])
  for (const idx of winIdx.split('\n').filter(Boolean)) {
    await execa('tmux', [...TMUX, 'set-window-option', '-t', `${session}:${idx}`, 'monitor-activity', 'on']) // prettier-ignore
    await execa('tmux', [...TMUX, 'set-window-option', '-t', `${session}:${idx}`, 'monitor-silence', '30']) // prettier-ignore
  }
  // Suppress the popup/bell so only the tab color changes — session-scoped, dashboard-only.
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'visual-activity', 'off'])
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'visual-silence', 'off'])

  // Style the tab bar so activity/silence states are visually distinct.
  // Tmux's conditional format: activity → amber, silence → green, default → grey.
  const windowFmt =
    '#{?window_silence_flag,#[fg=colour108]#[bold] #W ,#{?window_activity_flag,#[fg=colour214] #W ,#[fg=colour244] #W }}'
  const currentFmt = '#[fg=colour231,bg=colour238,bold] #W '
  await execa('tmux', [...TMUX, 'set-option', '-t', session, 'window-status-format', windowFmt])
  await execa('tmux', [
    ...TMUX,
    'set-option',
    '-t',
    session,
    'window-status-current-format',
    currentFmt,
  ])

  // Select the first requested tab (by name, so it's base-index independent) and attach.
  await execa('tmux', [...TMUX, 'select-window', '-t', `${session}:=${tabs[0].name}`])

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
  if (!running) {
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
