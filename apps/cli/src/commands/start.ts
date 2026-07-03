import { QuimbyError } from '@quimbyhq/errors'
import { localNewSessionArgs, prepareLocalTmuxLaunch, prepareSshLaunch } from '@quimbyhq/launch'
import { quimbyTmuxSocket, tmuxSessionName } from '@quimbyhq/paths'
import { runtimeTypes } from '@quimbyhq/runtimes'
import { getAgentSessionState } from '@quimbyhq/session'
import { sq } from '@quimbyhq/transport'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace, saveState } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

import { consolaReporter } from '../reporter'

export default defineCommand({
  meta: {
    name: 'start',
    description: 'Launch an agent headless in a detached tmux session',
  },
  args: {
    name: {
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
  },
  run: runStartCommand,
})

export async function runStartCommand({
  args,
}: {
  args: { name: string; cmd?: string; runtime?: string }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.name]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
  }

  // Headless launch means "already up" is a no-op, not a second session — a detached
  // start and a live `run` share the same UUID-keyed session.
  const existing = await getAgentSessionState(agent)
  if (existing !== 'stopped') {
    logger.info(
      `"${args.name}" is already ${existing} (tmux session "${tmuxSessionName(agent.id)}") — ` +
        `nudge or assign it, or \`quimby run ${args.name}\` to attach.`,
    )
    return
  }

  if (isSSH(agent.location)) {
    const launch = await prepareSshLaunch(
      { state, repoRoot, agent, location: agent.location, cmd: args.cmd, runtime: args.runtime },
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

    reportStarted(args.name, launch.sessionName, launch.host, launch.runtimeLabel)
    return
  }

  // A detached session is inherently a tmux session, so a local agent that never opted
  // into tmux is enrolled now (persisted) — otherwise `run`/`nudge`/`list` wouldn't
  // recognize the very session `start` just created.
  if (!agent.tmux) {
    state.agents[args.name].tmux = true
    await saveState(repoRoot, state)
    logger.info(`Enabled tmux for "${args.name}" (headless start runs in a tmux session).`)
  }

  const launch = await prepareLocalTmuxLaunch({
    state,
    repoRoot,
    agent: state.agents[args.name],
    cmd: args.cmd,
    runtime: args.runtime,
  })

  await execa('tmux', localNewSessionArgs(launch, { detached: true }))

  reportStarted(args.name, launch.sessionName, undefined, launch.runtimeLabel)
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
