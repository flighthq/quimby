import { syncAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'sync',
    description:
      'Sync agent(s) to their base, keeping their work (-f hard-resets, --base retargets)',
  },
  args: {
    name: {
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
  },
  run: runSyncCommand,
})

export async function runSyncCommand({
  args,
}: {
  args: { name?: string; _?: string[]; all: boolean; force: boolean; base?: string }
}): Promise<void> {
  const { state, repoRoot } = await resolveWorkspace()

  const explicit = [args.name, ...(args._ ?? [])].filter((n): n is string => Boolean(n))

  if (!args.all && explicit.length === 0) {
    throw new QuimbyError('Specify one or more agent names, or use --all')
  }
  if (args.all && args.base) {
    throw new QuimbyError('--base retargets a single agent; use it with a name, not --all')
  }

  const names = args.all ? Object.keys(state.agents) : explicit
  if (names.length === 0) {
    logger.info('No agents to sync.')
    return
  }

  for (const name of names) {
    if (!state.agents[name]) {
      throw new QuimbyError(`Agent "${name}" not found`)
    }
    const prevSeed = state.agents[name].seedCommit

    try {
      const result = await syncAgent(repoRoot, name, { force: args.force, base: args.base })
      const seedShort = result.newSeed.slice(0, 8)
      if (args.force) {
        logger.success(`${name}: hard-reset to ${seedShort}`)
      } else if (result.newSeed === prevSeed) {
        logger.info(`${name}: already up to date`)
      } else if (result.rebased) {
        logger.success(`${name}: ${result.commitsReplayed} commit(s) rebased onto ${seedShort}`)
      } else {
        logger.success(`${name}: fast-forwarded to ${seedShort}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // In --all mode a conflicted agent is skipped, not fatal — resync the rest.
      if (args.all) {
        logger.warn(`${name}: skipped — ${message}`)
        continue
      }
      throw err
    }
  }
}
