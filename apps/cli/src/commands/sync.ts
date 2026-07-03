import { syncAgents } from '@quimbyhq/agent'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { consolaReporter } from '../reporter'

export default defineCommand({
  meta: {
    name: 'sync',
    description:
      'Sync agent(s) to their base, keeping their work (-f hard-resets; --base/--current retarget)',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent name(s) to sync (omit with --all)',
      required: false,
    },
    all: {
      type: 'boolean',
      description: 'Sync every agent, skipping any with conflicts',
      default: false,
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: "Hard-reset to the base, discarding the agent's work (its mailbox is kept)",
      default: false,
    },
    base: {
      type: 'string',
      description: "Retarget the agent's sync ref to this branch, then sync onto it",
    },
    current: {
      type: 'boolean',
      description: "Retarget to the host's current branch, then sync onto it (pairs with -f)",
      default: false,
    },
  },
  run: runSyncCommand,
})

export async function runSyncCommand({
  args,
}: {
  args: {
    agent?: string
    _?: string[]
    all: boolean
    force: boolean
    base?: string
    current: boolean
  }
}): Promise<void> {
  const { state, repoRoot } = await resolveWorkspace()

  // citty puts every positional in `args._` (including the one bound to `agent`), so
  // dedupe to avoid syncing the first agent twice.
  const names = [...new Set([args.agent, ...(args._ ?? [])].filter((n): n is string => Boolean(n)))]

  await syncAgents(
    {
      state,
      repoRoot,
      names,
      all: args.all,
      force: args.force,
      base: args.base,
      current: args.current,
    },
    consolaReporter,
  )
}
