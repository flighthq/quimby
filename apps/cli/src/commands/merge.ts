import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { syncAgent } from '@quimbyhq/agent'
import { ConflictError, QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import {
  applyHandoff,
  type ApplyMode,
  discardHandoff,
  getWorkingParcelName,
  readHandoff,
} from '@quimbyhq/handoff'
import { getStagingHandoffDir } from '@quimbyhq/paths'
import type { AgentState, QuimbyState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { colors } from 'consola/utils'
import { execa } from 'execa'
import { join, resolve } from 'pathe'

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
      description: 'Commit message (skips the editor)',
    },
    rebase: {
      type: 'boolean',
      description: 'Rebase the agent onto host HEAD before merging',
      default: false,
    },
    sync: {
      type: 'boolean',
      description:
        "Advance the agent's seed onto the merge when it lands cleanly on the agent's branch (on by default; --no-sync to skip)",
      default: true,
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
    sync: boolean
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

  // Crossing the boundary is an explicit act, so the one commit a squashed merge makes is
  // authored by the user: with no -m we open git's editor (prefilled with the suggested
  // message). With no editor to open (not a TTY) we degrade to --patch — the work still
  // lands, uncommitted, for the user to commit — rather than inventing a message.
  // --commits and --patch never synthesize a message, so they are left untouched.
  let effectiveMode = mode
  let message = args.message
  if (mode === 'squashed' && message === undefined) {
    if (isInteractive()) {
      message = await editCommitMessage(repoRoot, meta.suggestedMessage)
      if (!message) throw new QuimbyError('Merge aborted — empty commit message.')
    } else {
      effectiveMode = 'patch'
    }
  }

  logger.start(`Merging "${name}" (${effectiveMode} mode)`)

  try {
    const result = await applyHandoff({
      repoRoot,
      name,
      targetRepoPath,
      mode: effectiveMode,
      branch,
      message,
    })

    await discardHandoff(repoRoot, name)

    logger.success(`Merged "${name}"`)

    // Work left uncommitted (explicit --patch, the no-TTY degrade, or a --commits
    // remainder): an incomplete landing — no quip, no seed advance. Say what to commit,
    // and how to catch the agent up afterward so it doesn't drift into conflicts.
    if (result.leftUncommitted) {
      reportUncommittedLanding({
        intendedMode: mode,
        effectiveMode,
        suggestedMessage: meta.suggestedMessage,
        agent: isAgent ? args.agent : undefined,
      })
      return
    }

    // A clean base hit: the work is fully committed. Advance the agent's seed when that's
    // safe (else point at the manual catch-up), then celebrate.
    if (isAgent) {
      if (args.sync) {
        await settleAgentSeed({
          state,
          repoRoot,
          agent: state.agents[args.agent],
          name: args.agent,
          mergedName: meta.name,
          targetRepoPath,
          landedOnBranch: branch !== undefined,
        })
      } else {
        logger.info(
          `Seed left unchanged (--no-sync) — catch "${args.agent}" up with ` +
            `\`quimby sync ${args.agent} --current -f\` before its next revision.`,
        )
      }
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

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

/**
 * Open git's configured editor (honoring core.editor / $GIT_EDITOR / $EDITOR) on a
 * prefilled message and return the edited text with comment lines stripped, git-commit
 * style. An empty result signals an abort.
 */
async function editCommitMessage(repoRoot: string, prefill: string): Promise<string> {
  const editor = (await execa('git', ['var', 'GIT_EDITOR'], { cwd: repoRoot })).stdout.trim()
  const file = join(tmpdir(), `quimby-merge-msg-${crypto.randomUUID()}.txt`)
  await writeFile(
    file,
    `${prefill}\n\n` +
      `# Please enter the commit message for the work you're merging.\n` +
      `# Lines starting with '#' are ignored, and an empty message aborts the merge.\n`,
  )
  try {
    // The editor may carry args (e.g. "code --wait"), so run the whole command via a shell.
    await execa(`${editor} "${file}"`, { stdio: 'inherit', shell: true })
    const edited = await readFile(file, 'utf8')
    return edited
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
      .trim()
  } finally {
    await rm(file, { force: true })
  }
}

/**
 * Report an incomplete (uncommitted) landing and how to finish it: what to commit, and —
 * for an agent source — the catch-up sync a fully-committed merge would have done
 * automatically, so the agent doesn't drift onto a stale baseline.
 */
function reportUncommittedLanding(opts: {
  intendedMode: ApplyMode
  effectiveMode: ApplyMode
  suggestedMessage: string
  agent?: string
}): void {
  const { intendedMode, effectiveMode, suggestedMessage, agent } = opts
  if (effectiveMode === 'patch') {
    if (intendedMode === 'squashed') {
      logger.info('No terminal to author a commit message (and no -m) — left the work uncommitted.')
    } else {
      logger.info('Changes landed in the working tree — no commit created.')
    }
    logger.info(`  Commit when ready. Suggested message: ${suggestedMessage}`)
  } else {
    logger.info(
      "Replayed the agent's commits; its uncommitted remainder is in your working tree — " +
        'commit it when ready, or re-run with `--commits -m "…"`.',
    )
  }
  if (agent) {
    logger.info(
      `Then catch "${agent}" up with \`quimby sync ${agent} --current -f\` so it doesn't drift.`,
    )
  }
}

/**
 * After a clean, committed merge, advance the agent's seed onto what just landed so its
 * next diff carries only new work. Runs the force sync only when it is provably lossless:
 *
 *  - the merge settled onto the branch this agent tracks, in the host repo (no `-b`,
 *    no foreign `-t`, and HEAD is the agent's syncRef) — otherwise the work isn't on
 *    syncRef and resetting the agent would drop it from its baseline, and
 *  - the agent hasn't changed since the snapshot we merged (equal parcel names) —
 *    otherwise the `reset --hard` in syncAgent would silently discard newer work.
 *
 * When a guard blocks the advance it points at the manual catch-up instead of resetting.
 */
async function settleAgentSeed(opts: {
  state: Readonly<QuimbyState>
  repoRoot: string
  agent: Readonly<AgentState>
  name: string
  mergedName: string
  targetRepoPath: string
  landedOnBranch: boolean
}): Promise<void> {
  const { state, repoRoot, agent, name, mergedName, targetRepoPath, landedOnBranch } = opts
  const catchUp = `\`quimby sync ${name} --current -f\``

  // Compare git toplevels, not raw paths: `repoRoot` is `--show-toplevel`, while
  // `targetRepoPath` defaults to the cwd, which may be a subdirectory of the same repo.
  // A raw `!==` would treat a merge run from a subdir as a foreign target and skip the
  // advance. Only a genuinely different repo (or a non-repo path) is "off the branch".
  const targetTop = await git.findRoot(targetRepoPath)
  if (landedOnBranch || targetTop !== repoRoot) {
    logger.info(`Landed off "${name}"'s tracked branch — catch it up when ready with ${catchUp}.`)
    return
  }

  const syncRef = agent.syncRef ?? state.sourceRef
  let syncTip: string
  let headTip: string
  try {
    syncTip = await git.revParse(repoRoot, syncRef)
    headTip = await git.revParse(repoRoot, 'HEAD')
  } catch {
    logger.info(
      `Couldn't resolve "${name}"'s tracked branch (${syncRef}) — catch it up with ${catchUp}.`,
    )
    return
  }
  if (syncTip !== headTip) {
    logger.info(
      `Merge isn't on "${name}"'s tracked branch (${syncRef}) — catch it up with ${catchUp}.`,
    )
    return
  }

  const liveName = await getWorkingParcelName({
    repoRoot,
    from: name,
    codeSourceId: agent.id,
    location: agent.location,
    projectId: state.id,
  })
  if (liveName !== mergedName) {
    logger.info(
      `"${name}" has new work since the merge — left its seed alone. Run ${catchUp} once it's idle.`,
    )
    return
  }

  const result = await syncAgent(repoRoot, name, { force: true })
  logger.success(`Advanced "${name}" seed → ${result.newSeed.slice(0, 8)}`)
}
