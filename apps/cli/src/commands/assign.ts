import { QuimbyError } from '@quimbyhq/errors'
import { getAgentDir, remoteAgentDir } from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import { isSSH } from '@quimbyhq/types'
import { logger, readText, writeText } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { join } from 'pathe'

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
  },
  run: runAssignCommand,
})

export async function runAssignCommand({ args }: { args: { name: string; message?: string } }) {
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
    const rAgentDir = remoteAgentDir(state.id, args.name, agent.location.base)
    await transport.writeFile(`${rAgentDir}/assignment.md`, taskContent)
  } else {
    const agentDir = getAgentDir(repoRoot, args.name)
    await writeText(join(agentDir, 'assignment.md'), taskContent)
  }

  logger.success(`Assignment set for "${args.name}"`)
}
