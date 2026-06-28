import { defineCommand } from 'citty'
import { resolve } from 'pathe'

import { type ApplyMode, applyPack, readPack } from '../core/pack'
import { resolveWorkspace } from '../core/workspace'
import { ConflictError, QuimbyError } from '../utils/errors'
import { logger } from '../utils/logger'
import { getPackDir } from '../utils/paths'

export default defineCommand({
  meta: {
    name: 'apply',
    description: 'Apply a pack to your repository',
  },
  args: {
    pack: {
      type: 'positional',
      description: 'Pack name',
      required: true,
    },
    commits: {
      type: 'boolean',
      description: 'Replay individual commits instead of squashing',
      default: false,
    },
    patch: {
      type: 'boolean',
      description: 'Apply as working tree changes without committing',
      default: false,
    },
    '3way': {
      type: 'boolean',
      description:
        'Use 3-way merge when applying — leaves conflict markers on overlap instead of aborting',
      default: false,
    },
    branch: {
      type: 'string',
      alias: 'b',
      description: 'Create a branch before applying (default name: quimby/<pack>)',
    },
    target: {
      type: 'string',
      alias: 't',
      description: 'Target repo path (defaults to current directory)',
    },
  },
  run,
})

async function run({
  args,
}: {
  args: {
    pack: string
    commits: boolean
    patch: boolean
    '3way': boolean
    branch?: string
    target?: string
  }
}) {
  const { repoRoot } = await resolveWorkspace()

  if (args.commits && args.patch) {
    throw new QuimbyError('Cannot use --commits and --patch together')
  }

  const mode: ApplyMode = args.commits ? 'commits' : args.patch ? 'patch' : 'squashed'
  const threeWay = args['3way']
  const targetRepoPath = resolve(args.target ?? process.cwd())
  const branch: boolean | string | undefined =
    args.branch !== undefined ? (args.branch === '' ? true : args.branch) : undefined

  const { meta } = await readPack(repoRoot, args.pack)

  logger.start(`Applying pack "${args.pack}" (${mode} mode${threeWay ? ', 3-way merge' : ''})`)

  try {
    await applyPack({ repoRoot, packName: args.pack, targetRepoPath, mode, branch, threeWay })
  } catch (err) {
    if (err instanceof ConflictError) {
      logger.warn(`${err.message}`)
      logger.info('Conflicted files:')
      for (const f of err.conflicts) {
        logger.info(`  ${f}`)
      }
      logger.info(`Pack files: ${getPackDir(repoRoot, args.pack)}`)
      logger.info('Resolve the conflicts, then run:')
      logger.info(`  git add -A && git commit -m ${JSON.stringify(meta.suggestedMessage)}`)
      process.exit(1)
    }
    throw err
  }

  logger.success(`Pack "${args.pack}" applied`)
  if (mode === 'patch') {
    logger.info(`Changes in working tree — no commit created. Suggested message:`)
    logger.info(`  ${meta.suggestedMessage}`)
  }
  logger.info(`Resync other workers when ready: quimby advance --all`)
}
