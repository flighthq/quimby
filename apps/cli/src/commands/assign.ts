import { getAgentSyncStatus, syncAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { getAgentDir, remoteAgentDir } from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import { isSSH } from '@quimbyhq/types'
import { logger, readText, writeText } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { join } from 'pathe'

import { nudgeAgentSession } from '../nudge'

const NUDGE_TEXT = "Here's your assignment: @assignment.md"

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
      description:
        'Wake a running agent by injecting the assignment notice + Return into its tmux session (on by default; --no-nudge to skip)',
      default: true,
    },
    sync: {
      type: 'boolean',
      description: 'Sync the agent to its base before assigning (on by default; --no-sync to skip)',
      default: true,
    },
  },
  run: runAssignCommand,
})

export async function runAssignCommand({
  args,
}: {
  args: { name: string; message?: string; nudge: boolean; sync: boolean }
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

  if (args.sync) {
    const { behind } = await getAgentSyncStatus(repoRoot, agent, state.sourceRef)
    if (behind > 0) {
      logger.start(`"${args.name}" is ${behind} commit(s) behind — syncing`)
      const result = await syncAgent(repoRoot, args.name)
      if (result.rebased) {
        logger.success(
          `Rebased ${result.commitsReplayed} commit(s) onto ${result.newSeed.slice(0, 8)}`,
        )
      } else {
        logger.success(`Synced to ${result.newSeed.slice(0, 8)}`)
      }
    }
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
    await nudgeAgentSession({
      agent,
      displayName: args.name,
      text: NUDGE_TEXT,
    })
  }
}
