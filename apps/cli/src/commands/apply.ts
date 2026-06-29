import { ConflictError, QuimbyError } from '@quimbyhq/errors'
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
    name: 'apply',
    description: "Package an agent's work and apply it to your repository",
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent to apply (or a staged parcel left by a prior conflict)',
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
      description: 'Create a branch before applying (default name: quimby/<agent>-<sha>)',
    },
    target: {
      type: 'string',
      alias: 't',
      description: 'Target repo path (defaults to current directory)',
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Commit message for uncommitted work + suggested apply message',
    },
    rebase: {
      type: 'boolean',
      description: 'Rebase the agent onto host HEAD before applying',
      default: false,
    },
    'skip-guard': {
      type: 'boolean',
      description: "Skip the agent's configured guard command",
      default: false,
    },
    // citty maps `--no-verify` onto this `verify` flag (its built-in `--no-`
    // negation) — a literal `no-verify` arg would never flip, so the alias
    // lives here as the git-muscle-memory way to skip the guard.
    verify: {
      type: 'boolean',
      description: 'Run the guard before applying (--no-verify or --skip-guard to skip)',
      default: true,
    },
  },
  run: runApplyCommand,
})

export async function runApplyCommand({
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
    'skip-guard': boolean
    verify: boolean
  }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  if (args.commits && args.patch) {
    throw new QuimbyError('Cannot use --commits and --patch together')
  }

  const mode: ApplyMode = args.commits ? 'commits' : args.patch ? 'patch' : 'squashed'
  const threeWay = args['3way']
  const targetRepoPath = resolve(args.target ?? process.cwd())
  const branch: boolean | string | undefined =
    args.branch !== undefined ? (args.branch === '' ? true : args.branch) : undefined

  // An agent name stages fresh work (committing the dirty tree — apply ships
  // everything across the boundary); anything else is a parcel already staged
  // in `.quimby/staging/` (e.g. one a prior conflict left behind).
  const isAgent = Boolean(state.agents[args.agent])
  const name = isAgent
    ? (
        await stageParcel({
          state,
          repoRoot,
          from: args.agent,
          message: args.message,
          skipGuard: args['skip-guard'] || !args.verify,
          rebase: args.rebase,
        })
      ).name
    : args.agent

  const { meta } = await readHandoff(repoRoot, name)

  logger.start(`Applying "${name}" (${mode} mode${threeWay ? ', 3-way merge' : ''})`)

  try {
    await applyHandoff({ repoRoot, name, targetRepoPath, mode, branch, threeWay })
  } catch (err) {
    if (err instanceof ConflictError) {
      logger.warn(`${err.message}`)
      logger.info('Conflicted files:')
      for (const f of err.conflicts) {
        logger.info(`  ${f}`)
      }
      // Keep the staged parcel so the user can finish the apply by hand.
      logger.info(`Parcel kept at: ${getStagingHandoffDir(repoRoot, name)}`)
      logger.info('Resolve the conflicts, then run:')
      if (mode === 'commits') {
        logger.info('  git add -A && git am --continue   (or: git am --abort to bail out)')
      } else {
        logger.info(`  git add -A && git commit -m ${JSON.stringify(meta.suggestedMessage)}`)
      }
      process.exit(1)
    }
    // A plain (non-3way) git apply aborts on any context drift — typically the
    // agent's seed has diverged from your repo. Point at the recovery paths
    // instead of dead-ending on a bare "patch does not apply".
    if (!threeWay && (mode === 'squashed' || mode === 'patch')) {
      logger.error(err instanceof Error ? err.message : String(err))
      logger.info(
        "The patch didn't apply cleanly — your repo has drifted from the agent's seed. Try:",
      )
      logger.info(
        `  quimby apply ${args.agent} --3way      # merge, leaving conflict markers to resolve`,
      )
      logger.info(
        `  quimby apply ${args.agent} --commits   # replay the agent's commits individually`,
      )
      if (isAgent) {
        logger.info(
          `  quimby sync ${args.agent}             # rebase the agent onto your latest, then re-apply`,
        )
      }
      process.exit(1)
    }
    throw err
  }

  // Parcels are ephemeral: once the work has crossed into git, drop the bundle.
  await discardHandoff(repoRoot, name)

  logger.success(`Applied "${name}"`)
  if (mode === 'patch') {
    logger.info(`Changes in working tree — no commit created. Suggested message:`)
    logger.info(`  ${meta.suggestedMessage}`)
  }
  logger.info(`Resync other agents when ready: quimby sync --all`)
  logger.log(colors.dim(getQuimbySuccessQuip()))
}
