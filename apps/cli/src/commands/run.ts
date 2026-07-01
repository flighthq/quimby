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
import { buildContext, getRuntime, runtimeTypes } from '@quimbyhq/runtimes'
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

  // ── Local agent, opted into tmux ─────────────────────────────────────────────
  if (agent.tmux) {
    const launch = await prepareLocalTmuxLaunch({
      state,
      repoRoot,
      agent,
      cmd: args.cmd,
      runtime: args.runtime,
    })

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
    return
  }

  // ── Local agent, foreground ──────────────────────────────────────────────────
  const saved = agent.defaults
  const runtime =
    (args.runtime as RuntimeType | undefined) ?? (saved?.runtime as RuntimeType) ?? 'local'
  const entrypoint = args.cmd ?? saved?.entrypoint ?? 'claude'

  if (!runtimeTypes.includes(runtime)) {
    throw new QuimbyError(`Unknown runtime "${runtime}". Available: ${runtimeTypes.join(', ')}`)
  }

  const adapter = getRuntime(runtime)
  const ctx = buildContext(repoRoot, args.name, state.id, agent.id)
  const spec = await adapter.runSpec(ctx, entrypoint)
  const runtimeLabel = runtime !== 'local' ? ` [${runtime}]` : ''

  logger.start(`Running "${entrypoint}" in agent "${args.name}"${runtimeLabel}`)

  try {
    await execa(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: 'inherit' })
  } catch (err) {
    const e = err as { exitCode?: number }
    if (e.exitCode !== undefined && e.exitCode !== 0) {
      process.exit(e.exitCode)
    }
  }
}

// ── Dashboard mode ────────────────────────────────────────────────────────────
// Multiple agents → one tmux session, one window per agent. Each window runs the
// agent's entrypoint directly; activity/silence monitoring lights up the tabs.
// The reserved name "host" adds a plain terminal window (bash login shell in the
// repo root) — the user's command line inside the same tabbed view.

const HOST_WINDOW = 'host'

interface WindowSpec {
  name: string
  cwd: string
  cmd: string[]
  env?: [string, string][]
}

async function runDashboard(names: string[]): Promise<void> {
  const { state, repoRoot } = await resolveWorkspace()

  for (const name of names) {
    if (name !== HOST_WINDOW && !state.agents[name]) {
      throw new QuimbyError(`Agent "${name}" not found`)
    }
  }

  const windows: WindowSpec[] = []
  for (const name of names) {
    if (name === HOST_WINDOW) {
      windows.push({ name: HOST_WINDOW, cwd: repoRoot, cmd: ['bash', '-l'] })
      continue
    }
    const agent = state.agents[name]
    const window = isSSH(agent.location)
      ? await buildSSHWindow(name, agent, state, repoRoot)
      : buildLocalWindow(name, agent, state, repoRoot)
    windows.push(window)
  }

  const tmuxConf = getTmuxConfigPath(repoRoot)
  await writeText(tmuxConf, renderTmuxConfig())

  const session = dashboardSessionName(state.id)
  const TMUX = ['-L', quimbyTmuxSocket]

  // Create the session (detached) with the first window, then add the rest.
  const first = windows[0]
  const firstEnvArgs = (first.env ?? []).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  await execa('tmux', [
    ...TMUX,
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
    ...firstEnvArgs,
    ...first.cmd,
  ])

  for (const w of windows.slice(1)) {
    const envArgs = (w.env ?? []).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    await execa('tmux', [
      ...TMUX,
      'new-window',
      '-t',
      session,
      '-n',
      w.name,
      '-c',
      w.cwd,
      ...envArgs,
      ...w.cmd,
    ])
  }

  // Monitoring: light up tabs when an agent finishes (silence) or resumes (activity).
  // These are window options set as session defaults so every window inherits them.
  const monitorOpts: [string, string][] = [
    ['monitor-activity', 'on'],
    ['monitor-silence', '30'],
    ['visual-activity', 'off'],
    ['visual-silence', 'off'],
  ]
  for (const [opt, val] of monitorOpts) {
    await execa('tmux', [...TMUX, 'set-option', '-t', session, opt, val])
  }

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

  // Select the first window and attach.
  await execa('tmux', [...TMUX, 'select-window', '-t', `${session}:0`])

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

function buildLocalWindow(
  name: string,
  agent: AgentState,
  state: QuimbyState,
  repoRoot: string,
): WindowSpec {
  const runtime = (agent.defaults?.runtime as RuntimeType) ?? 'local'
  const entrypoint = agent.defaults?.entrypoint ?? 'claude'

  if (!runtimeTypes.includes(runtime)) {
    throw new QuimbyError(
      `Agent "${name}": unknown runtime "${runtime}". Available: ${runtimeTypes.join(', ')}`,
    )
  }

  const adapter = getRuntime(runtime)
  const ctx = buildContext(repoRoot, name, state.id, agent.id)
  const spec = adapter.runSpec(ctx, entrypoint)

  const baseCmd = [spec.command, ...spec.args.map((a) => (a === entrypoint ? sq(a) : a))].join(' ')
  const windowCmd = `${baseCmd}; __code=$?; [ "$__code" -eq 0 ] || { printf '\\n[quimby] agent exited with code %s — press Enter to close\\n' "$__code"; read -r _; }`

  const env = Object.entries(spec.env ?? {}).map(([k, v]) => [k, v] as [string, string])

  return {
    name,
    cwd: spec.cwd ?? repoRoot,
    cmd: ['bash', '-l', '-c', windowCmd],
    env: env.length > 0 ? env : undefined,
  }
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
