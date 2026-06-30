import { syncAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'sync',
    description:
      'Sync agent(s) to their base, keeping their work (-f hard-resets; --base/--current retarget)',
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
    name?: string
    _?: string[]
    all: boolean
    force: boolean
    base?: string
    current: boolean
  }
}): Promise<void> {
  const { state, repoRoot } = await resolveWorkspace()

  const explicit = [
    ...new Set([args.name, ...(args._ ?? [])].filter((n): n is string => Boolean(n))),
  ]

  if (!args.all && explicit.length === 0) {
    throw new QuimbyError('Specify one or more agent names, or use --all')
  }
  if (args.base && args.current) {
    throw new QuimbyError('Use --base <ref> or --current, not both')
  }
  if (args.all && args.base) {
    throw new QuimbyError('--base retargets a single agent; use it with a name, not --all')
  }

  // --current is sugar for `--base <the host's current branch>`, resolved once. Unlike
  // an arbitrary --base, it reads as "snap onto where I am", so it's allowed with --all
  // (retarget every agent onto the branch you're integrating on).
  let base = args.base
  if (args.current) {
    const branch = await git.getCurrentBranch(repoRoot)
    if (!branch) {
      throw new QuimbyError(
        'Cannot use --current: HEAD is detached (no branch to track). Pass --base <ref> instead.',
      )
    }
    base = branch
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
      const result = await syncAgent(repoRoot, name, { force: args.force, base })
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
