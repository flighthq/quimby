import { assignAgentTask } from '@quimbyhq/agent'
import { nudgeAgentSession } from '@quimbyhq/session'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { consolaReporter } from '../reporter'

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

  const result = await assignAgentTask(
    {
      state,
      repoRoot,
      name: args.name,
      message: args.message,
      sync: args.sync,
      nudge: args.nudge,
    },
    consolaReporter,
  )

  if (result.nudgeText !== null) {
    await nudgeAgentSession({
      agent: state.agents[args.name],
      clear: args.clear,
      displayName: args.name,
      text: result.nudgeText,
      reporter: consolaReporter,
    })
  }
}
