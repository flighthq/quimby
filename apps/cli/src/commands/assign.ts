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
    agent: {
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
      type: 'string',
      description:
        'Sync the agent to its base before assigning (on by default; --sync <ref> retargets to <ref> first; --no-sync skips)',
    },
    verify: {
      type: 'boolean',
      description:
        'Append a self-verification request to the assignment (the agent runs its `check` and records a quimby-attest block)',
      default: false,
    },
  },
  run: runAssignCommand,
})

export async function runAssignCommand({
  args,
}: {
  args: {
    agent: string
    message?: string
    nudge: boolean
    // `--sync <ref>` → string, `--no-sync` → false, bare `--sync`/absent → '' / undefined.
    sync?: string | boolean
    clear: boolean
    verify: boolean
  }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  // --no-sync yields `false`; a ref string retargets; absent/bare means "sync against the base".
  const doSync = args.sync !== false
  const syncRef = typeof args.sync === 'string' && args.sync !== '' ? args.sync : undefined

  const result = await assignAgentTask(
    {
      state,
      repoRoot,
      name: args.agent,
      message: args.message,
      sync: doSync,
      syncRef,
      nudge: args.nudge,
      verify: args.verify,
    },
    consolaReporter,
  )

  if (result.nudgeText !== null) {
    await nudgeAgentSession({
      agent: state.agents[args.agent],
      clear: args.clear,
      displayName: args.agent,
      text: result.nudgeText,
      reporter: consolaReporter,
    })
  }
}
