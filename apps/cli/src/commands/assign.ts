import { getAgentSyncStatus, syncAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { getAgentDir, remoteAgentDir } from '@quimbyhq/paths'
import { nudgeAgentSession } from '@quimbyhq/session'
import { getSSHTransport } from '@quimbyhq/transport'
import { isSSH } from '@quimbyhq/types'
import { logger, readText, writeText } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { join } from 'pathe'

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
    clear: {
      type: 'boolean',
      alias: 'c',
      description: "Type '/clear' first to reset the agent's context, then send the nudge",
      default: false,
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
  args: { name: string; message?: string; nudge: boolean; sync: boolean; clear: boolean }
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

  let syncFailed = false
  if (args.sync) {
    const { behind, syncRef } = await getAgentSyncStatus(repoRoot, agent, state.sourceRef)
    if (behind > 0) {
      logger.start(`"${args.name}" is ${behind} commit(s) behind ${syncRef} — syncing`)
      try {
        const result = await syncAgent(repoRoot, args.name)
        if (result.rebased) {
          logger.success(
            `Rebased ${result.commitsReplayed} commit(s) onto ${result.newSeed.slice(0, 8)}`,
          )
        } else {
          logger.success(`Synced to ${result.newSeed.slice(0, 8)}`)
        }
      } catch (err) {
        syncFailed = true
        const message = err instanceof Error ? err.message : String(err)
        logger.warn(`Sync failed — ${message}`)
        logger.warn('Assignment written, but the agent is stale. Resolve and run `quimby sync`.')
      }
    }
  }

  if (args.nudge && !syncFailed) {
    await nudgeAgentSession({
      agent,
      clear: args.clear,
      displayName: args.name,
      text: NUDGE_TEXT,
    })
  }
}
