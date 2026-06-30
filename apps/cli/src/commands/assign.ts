import { QuimbyError } from '@quimbyhq/errors'
import { getAgentDir, remoteAgentDir, tmuxSessionName } from '@quimbyhq/paths'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger, readText, writeText } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'
import { join } from 'pathe'

// Typed into a live agent's tmux session by --nudge: a short wake-up that points the
// agent at the assignment it should read, rather than retyping the whole task.
const NUDGE_TEXT = 'New assignment received — read ./assignment.md and proceed.'

export default defineCommand({
  meta: {
    name: 'assign',
    description: "Set an agent's current task",
  },
  args: {
    name: {
      type: 'positional',
      description: 'Agent name',
      required: true,
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Assignment message (or @file to read from a file)',
    },
    nudge: {
      type: 'boolean',
      alias: 'n',
      description: 'Wake a running agent: inject a notice + Return into its tmux session',
      default: false,
    },
  },
  run: runAssignCommand,
})

export async function runAssignCommand({
  args,
}: {
  args: { name: string; message?: string; nudge: boolean }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.name]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
  }

  let taskContent = args.message ?? ''
  if (taskContent.startsWith('@')) {
    taskContent = await readText(taskContent.slice(1))
  }
  if (!taskContent) {
    throw new QuimbyError('Provide a message with -m (use `quimby handoff` to deliver work)')
  }

  if (isSSH(agent.location)) {
    const transport = getSSHTransport(agent.location)
    const rAgentDir = remoteAgentDir(state.id, agent.id, agent.location.base)
    await transport.writeFile(`${rAgentDir}/assignment.md`, taskContent)
  } else {
    const agentDir = getAgentDir(repoRoot, agent.id)
    await writeText(join(agentDir, 'assignment.md'), taskContent)
  }

  logger.success(`Assignment set for "${args.name}"`)

  if (args.nudge) {
    await nudgeAgent(state.id, agent, args.name)
  }
}

/**
 * Wake a live agent by typing a notice and Return into its tmux session, so a
 * running interactive agent picks up the new assignment without the user switching
 * to its terminal. The session is identified by the agent's stable UUID, so a rename
 * never loses it. Only SSH agents and local agents opted into `tmux` have a session;
 * for any other agent, or when the session isn't running, this reports and no-ops —
 * the assignment was still written either way.
 */
async function nudgeAgent(
  projectId: string,
  agent: Readonly<AgentState>,
  displayName: string,
): Promise<void> {
  if (!isSSH(agent.location) && !agent.tmux) {
    logger.warn(
      `"${displayName}" has no tmux session to nudge (assignment.md was written). ` +
        `Enable tmux via \`quimby config ${displayName}\`, or run it with tmux.`,
    )
    return
  }

  const session = tmuxSessionName(projectId, agent.id)
  // Two send-keys: `-l` types the literal notice (no key-name parsing), then a
  // separate Enter submits it to the agent's prompt.
  const inject = `tmux send-keys -t ${sq(session)} -l ${sq(NUDGE_TEXT)} && tmux send-keys -t ${sq(session)} Enter`

  try {
    if (isSSH(agent.location)) {
      const transport = getSSHTransport(agent.location)
      await transport.exec(`tmux has-session -t ${sq(session)} 2>/dev/null && ${inject}`)
    } else {
      await execa('tmux', ['has-session', '-t', session])
      await execa('tmux', ['send-keys', '-t', session, '-l', NUDGE_TEXT])
      await execa('tmux', ['send-keys', '-t', session, 'Enter'])
    }
    logger.success(`Nudged "${displayName}" in tmux session "${session}"`)
  } catch {
    logger.warn(
      `"${displayName}" isn't running in tmux session "${session}" (assignment.md was written). ` +
        `Start it with \`quimby run ${displayName}\`.`,
    )
  }
}
