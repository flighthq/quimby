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
  const { repoRoot, name, targetRepoPath, mode } = opts
  const dir = getStagingHandoffDir(repoRoot, name)
  const { meta } = await readHandoff(repoRoot, name)

  if (!(await git.isClean(targetRepoPath))) {
    throw new QuimbyError('Target repo has uncommitted changes. Commit or stash first.')
  }

  if (!meta.seedCommit) {
    throw new QuimbyError(
      `Parcel "${name}" has no seed commit recorded — it was assembled before the merge-based ` +
        `apply was available. Re-stage it with "quimby apply ${meta.from}".`,
    )
  }

  const previousRef = await git.getCurrentRef(targetRepoPath)
  const tempBranch = `quimby/apply-${meta.from}-${meta.seedCommit.slice(0, 8)}`

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
          await git.addAll(targetRepoPath)
          await git.commit(targetRepoPath, meta.suggestedMessage, { skipHooks: true })
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
          const remainderPath = join(dir, 'uncommitted.diff')
          if (await exists(remainderPath)) {
            await git.apply(targetRepoPath, remainderPath)
            await git.addAll(targetRepoPath)
            await git.commit(targetRepoPath, `Uncommitted work from ${meta.from}`, {
              skipHooks: true,
            })
          }
        } else {
          const squashedPath = join(dir, 'squashed.diff')
          if (await exists(squashedPath)) {
            await git.apply(targetRepoPath, squashedPath)
            await git.addAll(targetRepoPath)
            await git.commit(targetRepoPath, meta.suggestedMessage, { skipHooks: true })
          }
        }
        break
      }
    }

    // Step 2: Switch back to the original branch (or the landing branch).
    const mergeTarget = landingBranch ?? previousRef
    await git.checkout(targetRepoPath, mergeTarget)

    // Step 3: Merge the temp branch in.
    const mergeMessage = opts.message ?? `Apply ${meta.from}: ${meta.suggestedMessage}`
    try {
      if (mode === 'patch') {
        await git.merge(targetRepoPath, tempBranch, { squash: true, noCommit: true })
      } else {
        await git.merge(targetRepoPath, tempBranch, { noFf: true, message: mergeMessage })
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

    // Step 4: Clean up the temp branch.
    await git.deleteBranch(targetRepoPath, tempBranch).catch(() => {})

    return { mode, tempBranch, conflicts: [] }
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
