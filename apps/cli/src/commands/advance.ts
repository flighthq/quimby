import { QuimbyError } from '@quimbyhq/errors'
import { logger } from '@quimbyhq/utils'
import { advanceWorker } from '@quimbyhq/worker'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'advance',
    description: 'Fast-forward worker repos to current host HEAD, preserving assignment and status',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Worker name(s) to advance (omit with --all)',
      required: false,
    },
    all: {
      type: 'boolean',
      description: 'Advance every worker, skipping any that are busy (uncommitted changes)',
      default: false,
    },
  },
  run: runAdvanceCommand,
})

export async function runAdvanceCommand({
  args,
}: {
  args: { name?: string; _?: string[]; all: boolean }
}): Promise<void> {
  const { state, repoRoot } = await resolveWorkspace()

  const explicit = [args.name, ...(args._ ?? [])].filter((n): n is string => Boolean(n))

  if (!args.all && explicit.length === 0) {
    throw new QuimbyError('Specify one or more worker names, or use --all')
  }

  const names = args.all ? Object.keys(state.workers) : explicit

  if (names.length === 0) {
    logger.info('No workers to advance.')
    return
  }

  for (const name of names) {
    const prevSeed = state.workers[name]?.seedCommit

    if (!state.workers[name]) {
      // An explicit name that doesn't exist is a hard error; --all only sees real names.
      throw new QuimbyError(`Worker "${name}" not found`)
    }

    try {
      const result = await advanceWorker(repoRoot, name)

      if (result.newSeed === prevSeed) {
        logger.info(`${name}: already up to date`)
        continue
      }

      const seedShort = result.newSeed.slice(0, 8)
      if (result.rebased) {
        logger.success(`${name}: ${result.commitsReplayed} commit(s) rebased onto ${seedShort}`)
      } else {
        logger.success(`${name}: fast-forwarded to ${seedShort}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // In --all mode a busy or conflicted worker is skipped, not fatal — the
      // whole point is to resync idle workers without disturbing the rest.
      if (args.all) {
        logger.warn(`${name}: skipped — ${message}`)
        continue
      }
      throw err
    }
  }
}
