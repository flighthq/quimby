import { rebaseAgentOntoBase } from '@quimbyhq/agent'
import { handoffWork } from '@quimbyhq/handoff'
import { nudgeAgentSession } from '@quimbyhq/session'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { consolaReporter } from '../reporter'

export default defineCommand({
  meta: {
    name: 'handoff',
    description: "Carry an agent's work to another agent, or your host's work to an agent",
  },
  args: {
    from: {
      type: 'positional',
      description: 'Source agent — or, used alone, the recipient (host → it)',
      required: true,
    },
    to: {
      type: 'positional',
      description: 'Recipient agent (when a source agent is given)',
      required: false,
    },
    message: {
      type: 'string',
      alias: 'm',
      description: "The parcel's note",
    },
    attach: {
      type: 'string',
      description: "Carry a different agent's diff than the source",
    },
    rebase: {
      type: 'boolean',
      description: 'Rebase the code source onto host HEAD before packaging',
      default: false,
    },
    nudge: {
      type: 'boolean',
      description:
        'Wake the recipient via its tmux session. Default: nudge only when the parcel carries a note (-m); --nudge / --no-nudge force it',
    },
    clear: {
      type: 'boolean',
      alias: 'c',
      description: "Type '/clear' first to reset the recipient's context, then send the nudge",
      default: false,
    },
  },
  run: runHandoffCommand,
})

export async function runHandoffCommand({
  args,
}: {
  args: {
    from: string
    to?: string
    message?: string
    attach?: string
    rebase: boolean
    nudge?: boolean
    clear: boolean
  }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  const result = await handoffWork(
    {
      state,
      repoRoot,
      from: args.from,
      to: args.to,
      message: args.message,
      attach: args.attach,
      nudge: args.nudge,
      beforeStage: args.rebase
        ? (name) => rebaseAgentOntoBase(repoRoot, name, consolaReporter).then(() => undefined)
        : undefined,
    },
    consolaReporter,
  )

  if (result.nudgeText !== null) {
    await nudgeAgentSession({
      agent: state.agents[result.to],
      clear: args.clear,
      displayName: result.to,
      text: result.nudgeText,
      reporter: consolaReporter,
    })
  }
}
