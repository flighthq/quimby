import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'

import { applyHandoff, type ApplyMode } from './apply'
import { discardHandoff, readHandoff } from './parcel'
import { stageParcel } from './stage'

export interface MergeAgentWorkOptions {
  state: Readonly<QuimbyState>
  repoRoot: string
  /** An agent name (its work is staged) or a raw parcel name already in staging. */
  agent: string
  /** Already-resolved absolute path of the repo to merge into. */
  targetRepoPath: string
  /** Whether the target repo was named explicitly (`-t`), which tunes the dirty-repo hint. */
  targetExplicit: boolean
  commits: boolean
  patch: boolean
  branch?: boolean | string
  message?: string
  beforeStage?: (codeSourceName: string) => Promise<void>
}

export interface MergeAgentWorkResult {
  /** The parcel name that was merged. */
  name: string
  mode: ApplyMode
  /** For patch mode, the message to suggest for the user's own commit. */
  suggestedMessage?: string
}

/**
 * Merge an agent's work (or an already-staged parcel) into the target repo — the one
 * verb that crosses the boundary. Stages the parcel when given an agent, then applies
 * it with git's merge-based strategy and discards the staging copy on success.
 *
 * A merge conflict throws `ConflictError` (from `applyHandoff`) with the staged parcel
 * left in place for the caller to report and retry; this operation never exits the
 * process, so lifecycle stays with the CLI.
 */
export async function mergeAgentWork(
  opts: Readonly<MergeAgentWorkOptions>,
  reporter: Reporter = silentReporter,
): Promise<MergeAgentWorkResult> {
  const { state, repoRoot, targetRepoPath } = opts

  if (opts.commits && opts.patch) {
    throw new QuimbyError('Cannot use --commits and --patch together')
  }

  const mode: ApplyMode = opts.commits ? 'commits' : opts.patch ? 'patch' : 'squashed'

  if (!(await git.isClean(targetRepoPath))) {
    throw new QuimbyError(
      `Target repo has uncommitted changes. Commit or stash first.${
        opts.targetExplicit
          ? ''
          : ' (merge lands in the current directory; use -t to target another repo.)'
      }`,
    )
  }

  const isAgent = Boolean(state.agents[opts.agent])
  const name = isAgent
    ? (
        await stageParcel({
          state,
          repoRoot,
          from: opts.agent,
          message: opts.message,
          beforeStage: opts.beforeStage,
        })
      ).name
    : opts.agent

  const { meta } = await readHandoff(repoRoot, name)
  reporter.start(`Merging "${name}" (${mode} mode)`)

  const result = await applyHandoff({
    repoRoot,
    name,
    targetRepoPath,
    mode,
    branch: opts.branch,
    message: opts.message,
  })

  await discardHandoff(repoRoot, name)
  reporter.success(`Merged "${name}"`)

  return {
    name,
    mode: result.mode,
    suggestedMessage: meta.suggestedMessage,
  }
}
