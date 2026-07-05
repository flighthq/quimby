import { setTimeout as delay } from 'node:timers/promises'

import { readAgentStatus } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import {
  localNewSessionArgs,
  prepareLocalTmuxLaunch,
  prepareSshLaunch,
  QUIMBY_ROOT_TMUX_FORMAT,
  QUIMBY_ROOT_TMUX_OPTION,
  quimbyRootNewWindowBindingArgs,
  tmuxSetQuimbyRootShell,
} from '@quimbyhq/launch'
import { quimbyTmuxSocket, tmuxSessionName } from '@quimbyhq/paths'
import { runtimeTypes } from '@quimbyhq/runtimes'
import { getAgentSessionState, nudgeAgentSession } from '@quimbyhq/session'
import { renderResumeRequest } from '@quimbyhq/template'
import { sq } from '@quimbyhq/transport'
import type { AgentState, QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { loadQuimbyConfig, resolveWorkspace, saveState } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

import { ensureAgentConnections } from '../hostAlias'
import { recordLaunchFingerprint, warnIfLaunchDrifted } from '../launchDrift'
import { consolaReporter } from '../reporter'

// A freshly-launched agent needs a beat to bring up its prompt before the resume nudge is typed,
// or the text races into a not-yet-ready TUI.
const RESUME_SETTLE_MS = 1500

async function applyLocalRootBehavior(session: string, rootCwd: string): Promise<void> {
  const serverRunning = await execa('tmux', ['-L', quimbyTmuxSocket, 'list-sessions']).then(
    () => true,
    () => false,
  )
  if (!serverRunning) return
  await execa('tmux', ['-L', quimbyTmuxSocket, ...quimbyRootNewWindowBindingArgs()]).catch(() => {})
  await execa('tmux', [
    '-L',
    quimbyTmuxSocket,
    'set-option',
    '-t',
    session,
    QUIMBY_ROOT_TMUX_OPTION,
    rootCwd,
  ]).catch(() => {})
}

function remoteRootBehaviorShell(session: string, rootCwd: string): string {
  return (
    `if tmux -L ${sq(quimbyTmuxSocket)} list-sessions >/dev/null 2>&1; then ` +
    `tmux -L ${sq(quimbyTmuxSocket)} bind c new-window -c ` +
    `${sq(QUIMBY_ROOT_TMUX_FORMAT)} 2>/dev/null; ` +
    tmuxSetQuimbyRootShell(rootCwd, {
      socket: quimbyTmuxSocket,
      target: sq(session),
    }) +
    `fi; `
  )
}

export default defineCommand({
  meta: {
    name: 'start',
    description: 'Launch an agent headless in a detached tmux session',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent name',
      required: true,
    },
    cmd: {
      type: 'string',
      description: 'Entrypoint command to launch (overrides the agent default)',
    },
    runtime: {
      type: 'string',
      alias: 'r',
      description: `Runtime override (${runtimeTypes.join(', ')})`,
    },
    runtimeProfile: {
      type: 'string',
      description: 'Runtime profile override for this run',
    },
  },
  run: runStartCommand,
})

export async function runStartCommand({
  args,
}: {
  args: { agent: string; cmd?: string; runtime?: string; runtimeProfile?: string }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.agent]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }

  const config = await loadQuimbyConfig(repoRoot)
  const launchOpts = {
    cmd: args.cmd,
    runtime: args.runtime,
    runtimeProfile: args.runtimeProfile,
  }

  // Headless launch means "already up" is a no-op, not a second session — a detached
  // start and a live `run` share the same UUID-keyed session.
  const existing = await getAgentSessionState(agent)
  if (existing !== 'stopped') {
    logger.info(
      `"${args.agent}" is already ${existing} (tmux session "${tmuxSessionName(agent.id)}") — ` +
        `nudge or assign it, or \`quimby run ${args.agent}\` to attach.`,
    )
    warnIfLaunchDrifted(agent, config, launchOpts)
    return
  }

  // Bind any unbound SSH host alias (prompt + persist) before we touch the wire.
  await ensureAgentConnections(repoRoot, state, [args.agent])

  if (isSSH(agent.location)) {
    const launch = await prepareSshLaunch(
      {
        state,
        repoRoot,
        agent,
        location: agent.location,
        cmd: args.cmd,
        runtime: args.runtime,
        runtimeProfile: args.runtimeProfile,
      },
      consolaReporter,
    )

    // `new-session -A -d`: create detached if missing, never attach — so it can't steal
    // the terminal. cwd/config are unquoted so the remote shell expands `~`; the
    // session/window/command are quoted.
    const cmd = [
      'tmux',
      '-L',
      quimbyTmuxSocket,
      '-f',
      launch.tmuxConf,
      'new-session',
      '-A',
      '-d',
      '-s',
      sq(launch.sessionName),
      '-n',
      sq(launch.windowName),
      '-c',
      launch.cwd,
      'bash',
      '-l',
      '-c',
      sq(launch.shellCmd),
    ].join(' ')
    await launch.transport.exec(cmd)
    await launch.transport
      .exec(`${remoteRootBehaviorShell(launch.sessionName, launch.rootCwd)}true`)
      .catch(() => {})

    await recordLaunchFingerprint(repoRoot, state, args.agent, config, launchOpts)
    await resumeFromPredecessor(state, repoRoot, agent, args.agent)
    reportStarted(args.agent, launch.sessionName, launch.host, launch.runtimeLabel)
    return
  }

  // A detached session is inherently a tmux session, so a local agent that never opted
  // into tmux is enrolled now (persisted) — otherwise `run`/`nudge`/`list` wouldn't
  // recognize the very session `start` just created.
  if (!agent.tmux) {
    state.agents[args.agent].tmux = true
    await saveState(repoRoot, state)
    logger.info(`Enabled tmux for "${args.agent}" (headless start runs in a tmux session).`)
  }

  const launch = await prepareLocalTmuxLaunch({
    state,
    repoRoot,
    agent: state.agents[args.agent],
    cmd: args.cmd,
    runtime: args.runtime,
    runtimeProfile: args.runtimeProfile,
  })

  await execa('tmux', localNewSessionArgs(launch, { detached: true }))
  await applyLocalRootBehavior(launch.sessionName, launch.rootCwd)

  await recordLaunchFingerprint(repoRoot, state, args.agent, config, launchOpts)
  await resumeFromPredecessor(state, repoRoot, state.agents[args.agent], args.agent)
  reportStarted(args.agent, launch.sessionName, undefined, launch.runtimeLabel)
}

/**
 * The recovery loop: a `start` always creates a *fresh* session (it returns early when the agent
 * is already up), so if `status.md` carries a predecessor's handoff, point the new instance at it —
 * type a resume request into its session after a short settle so a crashed/reset agent picks up
 * where it left off. Empty/absent status ⇒ nothing to resume, no nudge.
 */
async function resumeFromPredecessor(
  state: Readonly<QuimbyState>,
  repoRoot: string,
  agent: Readonly<AgentState>,
  name: string,
): Promise<void> {
  const status = await readAgentStatus(repoRoot, state.id, agent)
  if (!status || !status.trim()) return
  logger.info(`"${name}" has a predecessor status.md — pointing it at @status.md to resume.`)
  await delay(RESUME_SETTLE_MS)
  await nudgeAgentSession({
    agent,
    displayName: name,
    text: renderResumeRequest(),
    reporter: consolaReporter,
  })
}

function reportStarted(
  name: string,
  session: string,
  host: string | undefined,
  runtimeLabel: string,
): void {
  const where = host ? ` on ${host}` : ''
  logger.success(`Started "${name}" headless in tmux session "${session}"${where}${runtimeLabel}`)
  logger.info(
    `Drive it with \`quimby assign ${name} -m "…"\` or \`quimby nudge ${name}\`, ` +
      `attach with \`quimby run ${name}\`, stop with \`quimby stop ${name}\`.`,
  )
}
