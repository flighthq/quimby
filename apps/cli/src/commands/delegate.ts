import { handoffWork } from '@quimbyhq/handoff'
import { nudgeAgentSession } from '@quimbyhq/session'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { consolaReporter } from '../reporter'

export default defineCommand({
  meta: {
    name: 'delegate',
    description: 'Give an agent a user-directed task through a trusted parcel',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Recipient agent',
      required: true,
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'The delegated task',
      required: true,
    },
    clear: {
      type: 'boolean',
      alias: 'c',
      description: "Type '/clear' first, then send the task",
      default: false,
    },
  },
  run: runDelegateCommand,
})

export async function runDelegateCommand({
  args,
}: {
  args: { agent: string; message: string; clear: boolean }
}) {
  const { state, repoRoot } = await resolveWorkspace()
  const result = await handoffWork(
    {
      state,
      repoRoot,
      from: args.agent,
      message: args.message,
      userDirected: true,
      noteOnly: true,
    },
    consolaReporter,
  )
  await nudgeAgentSession({
    agent: state.agents[result.to],
    clear: args.clear,
    displayName: result.to,
    courier: `delegated task ${result.parcelName} from ${result.from}`,
    reporter: consolaReporter,
  })
}
