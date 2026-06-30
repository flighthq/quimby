import { ConflictError, QuimbyError } from '@quimbyhq/errors'
import {
  applyHandoff,
  type ApplyMode,
  classifyParcelApplication,
  discardHandoff,
  readHandoff,
} from '@quimbyhq/handoff'
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
          rebase: args.rebase,
        })
      ).name
    : args.agent

  const { meta } = await readHandoff(repoRoot, name)

  // Classify the parcel against the target before touching git, so a re-send is
  // legible: "already shipped, go sync" vs "real overlap, resolve it" — instead of
  // git's raw conflict, which conflates the two.
  const { fresh, settled, drifted } = await classifyParcelApplication(
    repoRoot,
    name,
    targetRepoPath,
  )
  const total = fresh.length + settled.length + drifted.length
  if (total > 0) {
    logger.info(
      `${name}: ${total} file(s) — ${fresh.length} new, ${settled.length} already present, ${drifted.length} drifted`,
    )
  }
  // Everything already in your repo: the agent is re-sending shipped work against
  // its old seed. Don't replay a no-op into a confusing conflict — say so and stop.
  if (total > 0 && fresh.length === 0 && drifted.length === 0) {
    logger.success(`Nothing to apply — all ${settled.length} file(s) already match your repo.`)
    if (isAgent) {
      logger.info(`"${args.agent}" still measures its diff against its old seed. Advance it:`)
      logger.info(`  quimby sync ${args.agent} -f   # snap it to the latest, drop the shipped work`)
      await discardHandoff(repoRoot, name)
    }
    return
  }
  // `commits` replays git-am patches, which can't be file-filtered the way a diff can;
  // settled files are only dropped for the diff-based modes.
  const canSkipSettled = mode !== 'commits'
  if (settled.length > 0) {
    logger.info(
      colors.dim(
        canSkipSettled
          ? `  skipping ${settled.length} already-present file(s): ${settled.join(', ')}`
          : `  ${settled.length} already-present file(s) will be replayed (--commits can't skip them)`,
      ),
    )
  }
  if (drifted.length > 0) {
    logger.info(
      colors.dim(`  drifted: ${drifted.join(', ')} — real overlap; ${mode} may need --3way`),
    )
  }

  logger.start(`Applying "${name}" (${mode} mode${threeWay ? ', 3-way merge' : ''})`)

  try {
    await applyHandoff({
      repoRoot,
      name,
      targetRepoPath,
      mode,
      branch,
      threeWay,
      skipFiles: canSkipSettled ? settled : [],
    })
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
    // A plain (non-3way) git apply aborts on any context drift. Two very
    // different causes share this failure, so name the one we can detect:
    // files "already exist" means the work is already applied (re-apply), while
    // a context mismatch means the agent's seed has drifted from your repo.
    if (!threeWay && (mode === 'squashed' || mode === 'patch')) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const alreadyPresent = (errMsg.match(/already exists in working directory/g) ?? []).length
      if (alreadyPresent > 0) {
        // Already-applied: the raw git wall (one line per file) is pure noise here,
        // so summarize instead of dumping it, and lead with the cure.
        logger.warn(
          `Nothing to apply — ${alreadyPresent} of "${args.agent}"'s file(s) are already in your repo. This work looks already applied; the agent still measures its diff against its old seed.`,
        )
        if (isAgent) {
          logger.info(
            `  quimby sync ${args.agent}             # advance its baseline so there's nothing left to apply`,
          )
          logger.info(
            `  quimby sync ${args.agent} -f          # also drop the agent's local scratch work`,
          )
        }
      } else {
        logger.error(errMsg)
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
  logger.log(colors.dim(getQuimbySuccessQuip(args.agent)))
}
