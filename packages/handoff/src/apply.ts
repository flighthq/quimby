import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { ConflictError, QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getStagingHandoffDir } from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { join } from 'pathe'

import { readHandoff } from './parcel'

export type ApplyMode = 'squashed' | 'commits' | 'patch'

export interface ParcelClassification {
  /** Files that apply cleanly forward — genuinely new work. */
  fresh: string[]
  /** Files already present unchanged — shipped work re-sent against a stale seed. */
  settled: string[]
  /** Files the target diverged from — a real conflict needing resolution. */
  drifted: string[]
}

/**
 * Classify how a staged parcel's files would land in the target repo, so `apply` can
 * tell a forgot-to-sync re-send (all `settled`) apart from genuine overlap (`drifted`)
 * before it runs git and surfaces a conflict the user can't interpret.
 */
export async function classifyParcelApplication(
  repoRoot: string,
  name: string,
  targetRepoPath: string,
): Promise<ParcelClassification> {
  const { squashedDiff } = await readHandoff(repoRoot, name)
  return git.classifyDiffApplication(targetRepoPath, squashedDiff)
}

export async function applyHandoff(opts: {
  repoRoot: string
  name: string
  targetRepoPath: string
  mode: ApplyMode
  branch?: boolean | string
  threeWay?: boolean
  /**
   * Files to omit from the applied diff — already-present (settled) work the caller
   * has classified, so a re-send lands only what's new instead of `git apply` failing
   * wholesale on files the target already has. Applies to `squashed`/`patch` modes.
   */
  skipFiles?: readonly string[]
}): Promise<void> {
  const { repoRoot, name, targetRepoPath, mode, branch, threeWay } = opts
  const skipFiles = opts.skipFiles ?? []
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

  // Declared out here so `finally` cleans the temp patch up however the apply exits.
  let reducedDiffPath: string | undefined

  try {
    // For diff-based modes, drop settled files so a re-send applies only its unsettled
    // remainder instead of `git apply` failing wholesale on files already present.
    let squashedPath = join(dir, 'squashed.diff')
    let reducedIsEmpty = false
    if (skipFiles.length > 0 && (mode === 'squashed' || mode === 'patch')) {
      const reduced = git.filterDiffFiles(await readFile(squashedPath, 'utf-8'), skipFiles)
      if (reduced.trim() === '') {
        reducedIsEmpty = true
      } else {
        reducedDiffPath = join(tmpdir(), `quimby-apply-${crypto.randomUUID()}.diff`)
        await writeFile(reducedDiffPath, reduced)
        squashedPath = reducedDiffPath
      }
    }

    switch (mode) {
      case 'squashed': {
        // Everything was settled — nothing left to commit. (The CLI short-circuits
        // this earlier; guard here so a direct caller doesn't hit "nothing to commit".)
        if (reducedIsEmpty) break
        if (threeWay) {
          const conflicts = await git.applyThreeWay(targetRepoPath, squashedPath)
          if (conflicts.length > 0) {
            throw new ConflictError(
              `Handoff "${name}" applied with ${conflicts.length} conflict(s) — resolve then commit`,
              conflicts,
            )
          }
        } else {
          await git.apply(targetRepoPath, squashedPath, { check: true })
          await git.apply(targetRepoPath, squashedPath)
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
        if (reducedIsEmpty) break
        if (threeWay) {
          // Leave the merge result (and any conflict markers) in the working tree,
          // uncommitted — patch mode never commits, so the user curates from there.
          const conflicts = await git.applyThreeWay(targetRepoPath, squashedPath)
          if (conflicts.length > 0) {
            throw new ConflictError(
              `Handoff "${name}" applied with ${conflicts.length} conflict(s) — resolve the markers (left uncommitted)`,
              conflicts,
            )
          }
        } else {
          await git.apply(targetRepoPath, squashedPath)
        }
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
  } finally {
    if (reducedDiffPath) await rm(reducedDiffPath, { force: true })
  }
}
