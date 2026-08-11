import { syncAgents } from '@quimbyhq/agent'
import { SyncConflictError } from '@quimbyhq/errors'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { offerApplyBaseNudge, offerApplyBaseNudgeAll, offerConflictNudge } from '../conflictNudge'
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

  try {
    const outcomes = await syncAgents(
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

    // A sync that DELIVERED the base without applying it leaves the agent behind on purpose, and
    // nothing else here would tell the agent to take it: it finds out on its next `agent.sh`
    // invocation, which for an idle agent may be a long time and for a stopped one is never. So
    // offer the same way a conflict does — this is the direct product of a command just run.
    //
    // The sweep gets ONE offer for the whole set rather than a prompt per agent. It previously got
    // no offer at all, which made `sync --all` look like it failed where `sync <agent>` succeeded:
    // both defer identically, and only the single-agent path went on to ask.
    const deferred = outcomes.filter((o) => o.outcome === 'delivered')
    if (deferred.length === 1) {
      const agent = state.agents[deferred[0].name]
      if (agent) {
        await offerApplyBaseNudge({
          agent,
          displayName: deferred[0].name,
          behind: deferred[0].commitsReplayed,
          whenNonInteractive: 'print',
        })
      }
    } else if (deferred.length > 1) {
      await offerApplyBaseNudgeAll({
        agents: deferred.flatMap((o) => {
          const agent = state.agents[o.name]
          return agent ? [{ agent, displayName: o.name, behind: o.commitsReplayed }] : []
        }),
        whenNonInteractive: 'print',
      })
    }
  } catch (err) {
    // A rebase conflict rolled back cleanly: the agent's work is intact, and the fix is for the
    // agent to rebase and resolve in its own clone (where the code context is). Rather than leave
    // the user guessing what to tell it, offer to send exactly that request — never firing it
    // unasked, since waking an agent onto a conflicted baseline is the user's call.
    if (err instanceof SyncConflictError && err.agentClean && names.length === 1) {
      const agent = state.agents[names[0]]
      if (agent) {
        await offerConflictNudge({
          agent,
          displayName: names[0],
          syncRef: agent.syncRef ?? state.sourceRef,
          whenNonInteractive: 'print',
        })
      }
    }
    throw err
  }
}
