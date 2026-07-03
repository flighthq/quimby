import { readdir } from 'node:fs/promises'

import { ConflictError, QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getStagingHandoffDir } from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { join } from 'pathe'

import { readHandoff } from './parcel'

export type ApplyMode = 'squashed' | 'commits' | 'patch'

export interface ApplyResult {
  /** The mode that was applied. */
  mode: ApplyMode
  /** The temp branch name (useful if the user needs to clean up after a conflict). */
  tempBranch: string
  /** Conflicted file paths, empty when the merge was clean. */
  conflicts: string[]
  /**
   * True when work was intentionally left uncommitted in the target's working tree —
   * `patch` mode, or `commits` mode whose uncommitted remainder was not given a message.
   * The caller treats this as an incomplete landing: no celebration, no seed advance.
   */
  leftUncommitted: boolean
  /**
   * True when the target already contained every committed patch in the parcel. This is
   * the retry path after an interrupted post-apply cleanup/seed sync.
   */
  alreadyApplied: boolean
}

/**
 * Apply a staged parcel to the target repo using a merge-based strategy.
 *
 * Instead of patching the diff directly onto the target's working tree (which fails
 * when the target has moved past the agent's seed), this reconstructs the agent's work
 * on a temporary branch rooted at the seed commit — where the diff applies cleanly by
 * definition — then merges that branch into the target. Conflicts surface as standard
 * git merge conflicts on the host, resolvable with normal git tooling.
 */
export async function applyHandoff(opts: {
  repoRoot: string
  name: string
  targetRepoPath: string
  mode: ApplyMode
  branch?: boolean | string
  message?: string
}): Promise<ApplyResult> {
  const { repoRoot, name, mode } = opts
  const dir = getStagingHandoffDir(repoRoot, name)
  const { meta } = await readHandoff(repoRoot, name)

  // Normalize to the repo's top level. `git apply` and `git add` are cwd-relative and ignore
  // paths outside the cwd, so running the merge from a subdirectory (e.g. `quimby merge`
  // invoked below the repo root, where targetRepoPath is process.cwd()) would silently apply
  // nothing. Operating from the toplevel makes the diff land regardless of where it was invoked.
  const targetRepoPath = (await git.findRoot(opts.targetRepoPath)) ?? opts.targetRepoPath

  if (!(await git.isClean(targetRepoPath))) {
    throw new QuimbyError('Target repo has uncommitted changes. Commit or stash first.')
  }

  if (!meta.seedCommit) {
    throw new QuimbyError(
      `Parcel "${name}" has no seed commit recorded — it was assembled before the merge-based ` +
        `landing flow was available. Re-stage it with "quimby merge ${meta.from}".`,
    )
  }

  const previousRef =
    (await git.getCurrentBranch(targetRepoPath)) ?? (await git.getCurrentRef(targetRepoPath))
  const tempBranch = `quimby/merge-${meta.from}-${meta.seedCommit.slice(0, 8)}`
  if (previousRef === tempBranch) {
    throw new QuimbyError(
      `Target repo is on Quimby's temporary merge branch "${tempBranch}". ` +
        `Checkout the branch you meant to merge into, then rerun quimby merge.`,
    )
  }

  // If a landing branch was requested, create it from the current position before we
  // start — so the merge lands on that branch, not wherever the user was.
  let landingBranch: string | undefined
  if (opts.branch !== undefined && opts.branch !== false) {
    landingBranch = typeof opts.branch === 'string' ? opts.branch : `quimby/${meta.name}`
    if (await git.branchExists(targetRepoPath, landingBranch)) {
      await git.deleteBranch(targetRepoPath, landingBranch)
    }
    await git.createBranch(targetRepoPath, landingBranch)
  }

  // Clean up any leftover temp branch from a previous attempt.
  if (await git.branchExists(targetRepoPath, tempBranch)) {
    await git.deleteBranch(targetRepoPath, tempBranch)
  }

  let leftUncommitted = mode === 'patch'
  // The `commits`-mode uncommitted remainder is deferred until after the merge, so it can
  // land in the target's working tree (mirroring the agent's own committed/uncommitted
  // split) rather than being fabricated into a commit on the temp branch.
  let remainderPath: string | undefined

  try {
    // Step 1: Create temp branch from the seed commit and apply the diff there.
    // The diff was generated against this exact commit, so application is guaranteed clean.
    await git.createBranch(targetRepoPath, tempBranch, meta.seedCommit)

    switch (mode) {
      case 'squashed':
      case 'patch': {
        const squashedPath = join(dir, 'squashed.diff')
        if (await exists(squashedPath)) {
          await git.apply(targetRepoPath, squashedPath)
          await git.addAll(targetRepoPath, { exclude: ['.quimby'] })
          // An explicit -m names the landed work; it rides on this commit so it survives a
          // fast-forward (where no merge commit is created to carry it).
          await git.commit(targetRepoPath, opts.message ?? meta.suggestedMessage, {
            skipHooks: true,
          })
        }
        break
      }
      case 'commits': {
        const commitsDir = join(dir, 'commits')
        const sortedPatches = (await exists(commitsDir))
          ? (await readdir(commitsDir))
              .filter((f) => f.endsWith('.patch'))
              .sort()
              .map((f) => join(commitsDir, f))
          : []
        if (sortedPatches.length > 0) {
          await git.am(targetRepoPath, sortedPatches, { skipHooks: true })
          const rp = join(dir, 'uncommitted.diff')
          if (await exists(rp)) remainderPath = rp
        } else {
          const squashedPath = join(dir, 'squashed.diff')
          if (await exists(squashedPath)) {
            await git.apply(targetRepoPath, squashedPath)
            await git.addAll(targetRepoPath, { exclude: ['.quimby'] })
            await git.commit(targetRepoPath, opts.message ?? meta.suggestedMessage, {
              skipHooks: true,
            })
          }
        }
        break
      }
    }

    // Step 2: Switch back to the original branch (or the landing branch).
    const mergeTarget = landingBranch ?? previousRef
    await git.checkout(targetRepoPath, mergeTarget)

    if (
      mode !== 'patch' &&
      (await alreadyContainsCommittedPatches(targetRepoPath, tempBranch, meta.seedCommit))
    ) {
      await git.deleteBranch(targetRepoPath, tempBranch).catch(() => {})
      if (landingBranch) await git.checkout(targetRepoPath, previousRef)
      return { mode, tempBranch, conflicts: [], leftUncommitted: false, alreadyApplied: true }
    }

    // Step 3: Merge the temp branch in. No --no-ff: when the target is still at the seed
    // this fast-forwards to the agent's own commit (clean linear history, no boundary node);
    // when the target has diverged git creates a standard merge commit with its default
    // "Merge branch …" message — visibly a merge, and an obvious candidate to rebase away.
    try {
      if (mode === 'patch') {
        await git.merge(targetRepoPath, tempBranch, { squash: true, noCommit: true })
      } else {
        await git.merge(targetRepoPath, tempBranch)
      }
    } catch (mergeErr) {
      const conflicts = await git.getConflicts(targetRepoPath)
      if (conflicts.length > 0) {
        throw new ConflictError(
          `Merge has ${conflicts.length} conflict(s) — resolve then "git merge --continue"`,
          conflicts,
        )
      }
      await git.mergeAbort(targetRepoPath).catch(() => {})
      await git.checkout(targetRepoPath, previousRef).catch(() => {})
      if (landingBranch) await git.deleteBranch(targetRepoPath, landingBranch).catch(() => {})
      const detail = mergeErr instanceof Error ? mergeErr.message : String(mergeErr)
      throw new QuimbyError(`Merge failed:\n${detail}`)
    }

    // Step 3b: `commits`-mode remainder. The agent's committed history is now merged, so
    // the loose remainder applies cleanly onto it. With a message it becomes one commit;
    // without, it stays uncommitted in the working tree — the agent didn't commit it, so
    // quimby doesn't either.
    if (mode === 'commits' && remainderPath) {
      try {
        await git.apply(targetRepoPath, remainderPath)
      } catch (err) {
        throw new QuimbyError(
          `The agent's commits merged, but its uncommitted remainder didn't apply cleanly — ` +
            `resolve it by hand. ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (opts.message) {
        await git.addAll(targetRepoPath, { exclude: ['.quimby'] })
        await git.commit(targetRepoPath, opts.message, { skipHooks: true })
      } else {
        leftUncommitted = true
      }
    }

    // Step 4: Clean up the temp branch.
    await git.deleteBranch(targetRepoPath, tempBranch).catch(() => {})

    // A `-b` landing parks the work on its own branch and returns the user to where they
    // started — the branch is a place to keep the work, not a checkout to strand them on.
    // (Without `-b` the merge already happened on previousRef, so there is nothing to undo.)
    if (landingBranch) await git.checkout(targetRepoPath, previousRef)

    return { mode, tempBranch, conflicts: [], leftUncommitted, alreadyApplied: false }
  } catch (err) {
    if (err instanceof ConflictError) throw err
    // On unexpected failure, try to restore the user to where they were.
    await git.checkout(targetRepoPath, previousRef).catch(() => {})
    if (landingBranch) await git.deleteBranch(targetRepoPath, landingBranch).catch(() => {})
    await git.deleteBranch(targetRepoPath, tempBranch).catch(() => {})
    if (err instanceof QuimbyError) throw err
    throw new QuimbyError(
      `Failed to apply handoff "${name}" in ${mode} mode: ${err instanceof Error ? err.message : err}`,
    )
  }
}

async function alreadyContainsCommittedPatches(
  targetRepoPath: string,
  tempBranch: string,
  seedCommit: string,
): Promise<boolean> {
  if ((await git.countCommits(targetRepoPath, `${seedCommit}..${tempBranch}`)) === 0) {
    return false
  }
  const commits = await git.cherry(targetRepoPath, 'HEAD', tempBranch, seedCommit)
  return commits.length === 0 || commits.every((commit) => commit.equivalent)
}
