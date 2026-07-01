import { ConflictError, QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { applyHandoff, type ApplyMode, discardHandoff, readHandoff } from '@quimbyhq/handoff'
import { getStagingHandoffDir } from '@quimbyhq/paths'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { colors } from 'consola/utils'
import { resolve } from 'pathe'

import { stageParcel } from '../courier'
import { getQuimbySuccessQuip } from '../quips'

export default defineCommand({
  meta: {
    name: 'merge',
    description: "Merge an agent's work into your repository",
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent whose work to merge',
      required: true,
    },
    commits: {
      type: 'boolean',
      description: 'Replay individual commits instead of squashing',
      default: false,
    },
    patch: {
      type: 'boolean',
      description: 'Land as working tree changes without committing',
      default: false,
    },
    '3way': {
      type: 'boolean',
      description: 'Accepted for compatibility (the merge-based flow is always 3-way)',
      default: false,
    },
    branch: {
      type: 'string',
      alias: 'b',
      description: 'Create a branch before merging',
    },
    target: {
      type: 'string',
      alias: 't',
      description: 'Target repo path (defaults to current directory)',
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Commit message',
    },
    rebase: {
      type: 'boolean',
      description: 'Rebase the agent onto host HEAD before merging',
      default: false,
    },
  },
  run: runMergeCommand,
})

export async function runMergeCommand({
  args,
}: {
  args: {
    agent: string
    commits: boolean
    patch: boolean
    '3way': boolean
    branch?: string
    target?: string
    message?: string
    rebase: boolean
  }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  if (args.commits && args.patch) {
    throw new QuimbyError('Cannot use --commits and --patch together')
  }

  const mode: ApplyMode = args.commits ? 'commits' : args.patch ? 'patch' : 'squashed'
  const targetRepoPath = resolve(args.target ?? process.cwd())
  const branch: boolean | string | undefined =
    args.branch !== undefined ? (args.branch === '' ? true : args.branch) : undefined

  if (!(await git.isClean(targetRepoPath))) {
    throw new QuimbyError(
      `Target repo has uncommitted changes. Commit or stash first.${
        args.target ? '' : ' (merge lands in the current directory; use -t to target another repo.)'
      }`,
    )
  }

  const isAgent = Boolean(state.agents[args.agent])
  const name = isAgent
    ? (
        await stageParcel({
          state,
          repoRoot,
          from: args.agent,
          message: args.message,
          rebase: args.rebase,
        })
      ).name
    : args.agent

  const { meta } = await readHandoff(repoRoot, name)
  logger.start(`Merging "${name}" (${mode} mode)`)

  try {
    const result = await applyHandoff({
      repoRoot,
      name,
      targetRepoPath,
      mode,
      branch,
      message: args.message,
    })

    await discardHandoff(repoRoot, name)

    logger.success(`Merged "${name}"`)
    if (result.mode === 'patch') {
      logger.info(`Changes in working tree — no commit created. Suggested message:`)
      logger.info(`  ${meta.suggestedMessage}`)
    }
    logger.log(colors.dim(getQuimbySuccessQuip(args.agent)))
  } catch (err) {
    if (err instanceof ConflictError) {
      logger.warn(`${err.message}`)
      logger.info('Conflicted files:')
      for (const f of err.conflicts) {
        logger.info(`  ${f}`)
      }
      logger.info('Resolve the conflicts, then run:')
      logger.info('  git add -A && git merge --continue')
      logger.info(`Parcel kept at: ${getStagingHandoffDir(repoRoot, name)}`)
      process.exit(1)
    }
    throw err
  }
}
