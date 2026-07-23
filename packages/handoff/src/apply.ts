import { readdir, readFile } from 'node:fs/promises'

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
  /**
   * `commits` mode with no `-m`: the number of files in the agent's uncommitted remainder, which
   * is deliberately **not** pulled — it stays on the agent (keeping `--commits` idempotent, so a
   * re-gather only carries newly-committed work). The caller reports the count and points at the
   * modes that would grab it (`--patch`/`--squashed`, or `--commits -m`). Zero otherwise.
   */
  unpulledRemainderFiles: number
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
  let unpulledRemainderFiles = 0
  // The `commits`-mode uncommitted remainder is handled after the merge: with `-m` it is swept
  // into one commit, otherwise it is deliberately left on the agent (not pulled), so `--commits`
  // carries only committed work and stays idempotent across re-gathers.
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
          try {
            await git.am(targetRepoPath, sortedPatches, { skipHooks: true })
          } catch (amErr) {
            // git refuses to switch branches while an `am` is in progress, so a half-applied am
            // would strand the user on the temp branch (the outer catch's checkout silently
            // fails) with `.git/rebase-apply` left behind — the "broken state". Abort the am here
            // (mirroring the merge path's mergeAbort) so recovery returns cleanly to previousRef
            // with the staged parcel intact and retryable. The individual commits aren't
            // reconstructable here, so point the user at the modes that don't replay them.
            await git.amAbort(targetRepoPath)
            const detail = amErr instanceof Error ? amErr.message : String(amErr)
            throw new QuimbyError(
              `Could not replay the agent's commits with "git am" (${detail}). The parcel is kept — ` +
                `retry with "quimby merge ${meta.from}" (squashed, the default) or add --patch to ` +
                `land the work without replaying individual commits.`,
            )
          }
          const rp = join(dir, 'uncommitted.diff')
          if (await exists(rp)) remainderPath = rp
        } else {
          // No commits to replay: the whole delta is uncommitted. With `-m`, sweep it into one
          // commit; without, pull nothing and count it. `commits` mode never synthesizes a commit
          // from uncommitted work — that keeps it idempotent (a re-gather lands nothing new) and
          // never stamps a generic message. Grab it deliberately with --squashed/--patch/-m.
          const squashedPath = join(dir, 'squashed.diff')
          if (await exists(squashedPath)) {
            if (opts.message) {
              await git.apply(targetRepoPath, squashedPath)
              await git.addAll(targetRepoPath, { exclude: ['.quimby'] })
              await git.commit(targetRepoPath, opts.message, { skipHooks: true })
            } else {
              unpulledRemainderFiles = await countDiffFiles(squashedPath)
            }
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
      return {
        mode,
        tempBranch,
        conflicts: [],
        leftUncommitted: false,
        alreadyApplied: true,
        unpulledRemainderFiles,
      }
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

    // Step 3b: `commits`-mode remainder. With an explicit `-m`, sweep the agent's uncommitted
    // remainder into one trailing commit (it applies cleanly onto the just-merged history). With
    // no `-m`, the remainder is **not pulled** — it stays on the agent, so `--commits` carries
    // only committed work and re-gathering is idempotent (the raw-diff apply that used to
    // re-conflict on a re-run is gone). We only count its files, for the caller to report.
    if (mode === 'commits' && remainderPath) {
      if (opts.message) {
        try {
          await git.apply(targetRepoPath, remainderPath)
        } catch (err) {
          throw new QuimbyError(
            `The agent's commits merged, but its uncommitted remainder didn't apply cleanly — ` +
              `resolve it by hand. ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        await git.addAll(targetRepoPath, { exclude: ['.quimby'] })
        await git.commit(targetRepoPath, opts.message, { skipHooks: true })
      } else {
        unpulledRemainderFiles = await countDiffFiles(remainderPath)
      }
    }

    // Step 4: Clean up the temp branch.
    await git.deleteBranch(targetRepoPath, tempBranch).catch(() => {})

    // A `-b` landing parks the work on its own branch and returns the user to where they
    // started — the branch is a place to keep the work, not a checkout to strand them on.
    // (Without `-b` the merge already happened on previousRef, so there is nothing to undo.)
    if (landingBranch) await git.checkout(targetRepoPath, previousRef)

    return {
      mode,
      tempBranch,
      conflicts: [],
      leftUncommitted,
      alreadyApplied: false,
      unpulledRemainderFiles,
    }
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

// The number of files in a unified diff — one `diff --git` header per file. Used to report how
// many uncommitted files `--commits` left on the agent without reading them into the target.
async function countDiffFiles(diffPath: string): Promise<number> {
  const content = await readFile(diffPath, 'utf8')
  return (content.match(/^diff --git /gm) ?? []).length
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
