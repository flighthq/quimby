import { ConflictError, QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
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

  // Classification runs `git apply --check` against the target's working tree, so a
  // dirty target would misclassify (and the short-circuit/pre-empt below could return
  // before applyHandoff's own clean check ever runs). Gate it up front so a dirty repo
  // gets the right message, not a misleading "nothing to apply" / "use --3way".
  if (!(await git.isClean(targetRepoPath))) {
    throw new QuimbyError(
      `Target repo has uncommitted changes. Commit or stash first.${
        args.target ? '' : ' (apply lands in the current directory; use -t to target another repo.)'
      }`,
    )
  }

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
  // Everything already in your repo: the agent is re-sending shipped work against
  // its old seed. Don't replay a no-op into a confusing conflict — say so and stop.
  if (total > 0 && fresh.length === 0 && drifted.length === 0) {
    logger.success(`Nothing to apply — all ${settled.length} file(s) already in your repo.`)
    if (isAgent) {
      logger.info(`"${args.agent}" measures against its old seed — advance it:`)
      logger.info(`  quimby sync ${args.agent} -f   # snap to the latest, drop the shipped work`)
      await discardHandoff(repoRoot, name)
    }
    return
  }

  // `commits` replays git-am patches, which can't be file-filtered like a diff;
  // settled files are only dropped for the diff-based modes.
  const canSkipSettled = mode !== 'commits'

  // One quiet line, and only when something's worth flagging (work skipped or a
  // conflict ahead) — a clean all-new apply needs no preamble. Name the conflicts
  // (actionable); the settled files are just a count (nothing to do about them).
  if (settled.length > 0 || drifted.length > 0) {
    const parts: string[] = []
    if (fresh.length > 0) parts.push(`${fresh.length} new`)
    if (settled.length > 0) {
      parts.push(`${settled.length} already applied${canSkipSettled ? ', skipped' : ''}`)
    }
    if (drifted.length > 0) parts.push(`${drifted.length} conflicting (${drifted.join(', ')})`)
    logger.info(`${name}: ${total} file(s) — ${parts.join('; ')}`)
  }

  // A non-3way squashed/patch apply is atomic — one conflicting file aborts the whole
  // patch. We've already proven those files won't apply, so don't run git just to fail
  // on them: name the cure (the conflicts are in the line above) and stop here.
  if (drifted.length > 0 && !threeWay && (mode === 'squashed' || mode === 'patch')) {
    logger.warn(`Can't apply cleanly — the conflicting file(s) above must be merged.`)
    logger.info(`  quimby apply ${args.agent} --3way   # merge them, leaving markers to resolve`)
    if (isAgent) {
      logger.info(
        `  quimby sync ${args.agent}          # or rebase onto your latest, then re-apply`,
      )
      await discardHandoff(repoRoot, name)
    }
    process.exit(1)
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
    // Drift is pre-empted above, so reaching here on a diff-based mode means an
    // unexpected cause (not a classified conflict) — surface it directly rather than
    // dumping git's raw wall and guessing.
    if (!threeWay && (mode === 'squashed' || mode === 'patch')) {
      logger.error(err instanceof Error ? err.message : String(err))
      logger.info(`  quimby apply ${args.agent} --3way   # try a 3-way merge`)
      if (isAgent) {
        logger.info(`  quimby sync ${args.agent}          # rebase onto your latest, then re-apply`)
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
