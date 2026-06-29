import { readdir } from 'node:fs/promises'

import { ConflictError, QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getStagingHandoffDir } from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { join } from 'pathe'

import { readHandoff } from './parcel'

export type ApplyMode = 'squashed' | 'commits' | 'patch'

export async function applyHandoff(opts: {
  repoRoot: string
  name: string
  targetRepoPath: string
  mode: ApplyMode
  branch?: boolean | string
  threeWay?: boolean
}): Promise<void> {
  const { repoRoot, name, targetRepoPath, mode, branch, threeWay } = opts
  const dir = getStagingHandoffDir(repoRoot, name)
  const { meta } = await readHandoff(repoRoot, name)

  if (!(await git.isClean(targetRepoPath))) {
    throw new QuimbyError('Target repo has uncommitted changes. Commit or stash first.')
  }

  const previousRef = await git.getCurrentRef(targetRepoPath)
  let branchName: string | undefined

  if (branch !== undefined && branch !== false) {
    branchName = typeof branch === 'string' ? branch : `quimby/${meta.name}`
    if (await git.branchExists(targetRepoPath, branchName)) {
      await git.deleteBranch(targetRepoPath, branchName)
    }
    await git.createBranch(targetRepoPath, branchName)
  }

  try {
    switch (mode) {
      case 'squashed': {
        const diffPath = join(dir, 'squashed.diff')
        if (threeWay) {
          const conflicts = await git.applyThreeWay(targetRepoPath, diffPath)
          if (conflicts.length > 0) {
            throw new ConflictError(
              `Handoff "${name}" applied with ${conflicts.length} conflict(s) — resolve then commit`,
              conflicts,
            )
          }
        } else {
          await git.apply(targetRepoPath, diffPath, { check: true })
          await git.apply(targetRepoPath, diffPath)
        }
        await git.addAll(targetRepoPath)
        await git.commit(targetRepoPath, meta.suggestedMessage)
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
        if (sortedPatches.length === 0) {
          // No committed history to replay (e.g. uncommitted-only work) — fall back
          // to the full squashed diff, applied to the working tree.
          await git.apply(targetRepoPath, join(dir, 'squashed.diff'))
          break
        }
        try {
          await git.am(targetRepoPath, sortedPatches)
        } catch (amErr) {
          // git am --3way stops at the first conflicting patch and leaves the am
          // session in progress. Surface the conflicts so the user can resolve
          // them and `git am --continue`, rather than aborting their work.
          const conflicts = await git.getConflicts(targetRepoPath)
          if (conflicts.length > 0) {
            throw new ConflictError(
              `Handoff "${name}" stopped with ${conflicts.length} conflict(s) — resolve then "git am --continue"`,
              conflicts,
            )
          }
          throw amErr
        }
        // The agent's uncommitted/untracked remainder rides on top as working-tree
        // changes (no commit) so `--commits` loses nothing.
        const remainderPath = join(dir, 'uncommitted.diff')
        if (await exists(remainderPath)) await git.apply(targetRepoPath, remainderPath)
        break
      }
      case 'patch': {
        const diffPath = join(dir, 'squashed.diff')
        await git.apply(targetRepoPath, diffPath)
        break
      }
    }
  } catch (err) {
    if (err instanceof ConflictError) throw err
    try {
      await git.amAbort(targetRepoPath)
    } catch {}
    if (branchName) {
      await git.checkout(targetRepoPath, previousRef)
      try {
        await git.deleteBranch(targetRepoPath, branchName)
      } catch {}
    }
    throw new QuimbyError(
      `Failed to apply handoff "${name}" in ${mode} mode: ${err instanceof Error ? err.message : err}`,
    )
  }
}
