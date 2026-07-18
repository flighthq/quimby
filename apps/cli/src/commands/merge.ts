import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  getAgentAttestation,
  getAgentHeadHash,
  rebaseAgentOntoBase,
  syncAgent,
} from '@quimbyhq/agent'
import { ConflictError, HandoffError, QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import {
  applyHandoff,
  type ApplyMode,
  discardHandoff,
  getWorkingParcelName,
  healAbandonedStaging,
  readHandoff,
  stageParcel,
} from '@quimbyhq/handoff'
import { getStagingHandoffDir } from '@quimbyhq/paths'
import type { AgentState, QuimbyState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { loadQuimbyConfig, resolveWorkspace, saveMergeModeDefault } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { colors } from 'consola/utils'
import { execa } from 'execa'
import { join, resolve } from 'pathe'

import { attestationResolver, formatAttestation } from '../attestation'
import { getQuimbySuccessQuip } from '../quips'
import { consolaReporter } from '../reporter'

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
      type: 'string',
      description:
        "Align the agent's base to the merge, both ends, on by default: sync it onto the target before landing and advance its seed after, when landing on its tracked branch (--sync <ref> also retargets the sync ref; --no-sync leaves the base untouched at both ends)",
    },
    squashed: {
      type: 'boolean',
      description:
        'Squash into one commit — the built-in default, spelled out to override a configured commits/patch default',
      default: false,
    },
    default: {
      type: 'boolean',
      description:
        "Persist the chosen mode as this repo's default merge mode (bare `quimby merge`)",
      default: false,
    },
    global: {
      type: 'boolean',
      description: 'With --default, persist to user config (every repo) instead of this repo',
      default: false,
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
    squashed: boolean
    '3way': boolean
    branch?: string
    target?: string
    message?: string
    rebase: boolean
    // `--sync <ref>` → string, `--no-sync` → false, bare `--sync`/absent → '' / undefined.
    sync?: string | boolean
    default: boolean
    global: boolean
  }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  // Mode precedence: an explicit --commits/--patch/--squashed wins; else the configured
  // workspace/user default (git-style, resolved across the config layers); else squashed.
  const config = await loadQuimbyConfig(repoRoot)
  const mode = resolveMergeMode(args, config.mergeMode)

  // `--default` persists the chosen mode as the bare-`merge` default — to this repo, or user
  // config with `--global`. A config-setting side effect, independent of this merge's outcome.
  if (args.default) {
    const path = await saveMergeModeDefault(repoRoot, mode, { global: args.global })
    logger.info(`Default merge mode set to "${mode}" (${path})`)
  }
  // Uniform `--sync`: --no-sync (false) skips the seed advance; a ref string advances *and*
  // retargets the agent's sync ref to it; bare `--sync`/absent advances onto the landed branch.
  const advanceOn = args.sync !== false
  const retargetRef = typeof args.sync === 'string' && args.sync !== '' ? args.sync : undefined
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
  // Relay the agent's self-attestation before crossing the boundary — informational, never a gate:
  // the human decides. Absent reads as "not run", failed as "failed"; a drifted HEAD reads as stale.
  if (isAgent) {
    const src = state.agents[args.agent]
    const [att, liveHash] = await Promise.all([
      getAgentAttestation(repoRoot, state.id, src),
      getAgentHeadHash(repoRoot, state.id, src),
    ])
    logger.info(`check: ${formatAttestation(att, liveHash)}`)
  }
  // When staging fresh, silently sweep a staging area left by an abandoned prior merge
  // (conflict, then `git merge --abort`) so it never collides. Skipped when merging a parcel
  // by name — that path points at staging deliberately, and a live conflict is preserved by
  // healAbandonedStaging's own merge-in-progress guard.
  if (isAgent) await healAbandonedStaging(repoRoot, targetRepoPath)

  // Pre-sync (on by default): bring the agent onto the branch we're merging into *before*
  // capturing its diff, so base-drift conflicts — the agent's seed trailing other agents'
  // already-landed work — surface as a rebase in the agent's own clone (aborted there, work
  // intact) instead of a `git merge` left in your repo. Gated on merging into the branch the
  // agent tracks, exactly like the seed post-advance below; `--rebase` forces it ungated;
  // `--no-sync` (advanceOn=false) skips it. A rebase conflict is reported without crossing.
  if (isAgent && (args.rebase || advanceOn)) {
    const gate = args.rebase
      ? ({ ok: true } as const)
      : await mergingOntoTrackedBranch({
          repoRoot,
          targetRepoPath,
          agent: state.agents[args.agent],
          fallbackRef: state.sourceRef,
          landedOnBranch: branch !== undefined,
        })
    if (gate.ok) {
      try {
        await rebaseAgentOntoBase(repoRoot, args.agent, consolaReporter)
      } catch (err) {
        if (err instanceof QuimbyError) {
          throw new QuimbyError(`${err.message}\nThen re-run \`quimby merge ${args.agent}\`.`)
        }
        throw err
      }
    }
  }

  let name: string
  try {
    name = isAgent
      ? (
          await stageParcel({
            state,
            repoRoot,
            from: args.agent,
            message: args.message,
            resolveAttestation: attestationResolver(repoRoot, state),
          })
        ).name
      : args.agent
  } catch (err) {
    // The pre-sync (or a prior, interrupted merge) may have already brought the agent onto
    // its base, leaving nothing to carry. That's an integrated agent, not a failure — report
    // it cleanly. The pre-sync already advanced the seed, so there's nothing left to do.
    if (isAgent && err instanceof HandoffError) {
      logger.success(`Nothing to merge — "${args.agent}" is already up to date with its base.`)
      return
    }
    throw err
  }

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
      const authored = await editCommitMessage(repoRoot, meta.suggestedMessage)
      // A non-zero editor exit (e.g. `:cq` in vim) cancels the merge — bail silently, nothing
      // lands and nothing is printed. An empty (but saved) message still reports the abort.
      if (authored === null) return
      if (!authored) throw new QuimbyError('Merge aborted — empty commit message.')
      message = authored
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

    logger.success(
      result.alreadyApplied
        ? `Merged "${name}" was already present; finishing cleanup`
        : `Merged "${name}"`,
    )

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
      if (advanceOn) {
        await settleAgentSeed({
          state,
          repoRoot,
          agent: state.agents[args.agent],
          name: args.agent,
          mergedName: meta.name,
          targetRepoPath,
          landedOnBranch: branch !== undefined,
          retargetRef,
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
 * Resolve the merge mode: an explicit `--commits`/`--patch`/`--squashed` flag wins (at most one),
 * then the configured workspace/user default (resolved across the config layers, validated here
 * since YAML is untyped at load), then the built-in `squashed`.
 */
function resolveMergeMode(
  args: Readonly<{ commits: boolean; patch: boolean; squashed: boolean }>,
  configured: string | undefined,
): ApplyMode {
  const explicit = [
    args.commits ? 'commits' : undefined,
    args.patch ? 'patch' : undefined,
    args.squashed ? 'squashed' : undefined,
  ].filter(Boolean) as ApplyMode[]
  if (explicit.length > 1) {
    throw new QuimbyError('Choose at most one of --commits, --patch, --squashed')
  }
  if (explicit.length === 1) return explicit[0]
  if (configured !== undefined) {
    if (configured !== 'squashed' && configured !== 'commits' && configured !== 'patch') {
      throw new QuimbyError(
        `Config mergeMode "${configured}" is invalid — use "squashed", "commits", or "patch".`,
      )
    }
    return configured
  }
  return 'squashed'
}

/**
 * Open git's configured editor (honoring core.editor / $GIT_EDITOR / $EDITOR) on a
 * prefilled message and return the edited text with comment lines stripped, git-commit
 * style. An empty result signals an abort.
 */
export async function editCommitMessage(repoRoot: string, prefill: string): Promise<string | null> {
  const editor = (await execa('git', ['var', 'GIT_EDITOR'], { cwd: repoRoot })).stdout.trim()
  const dir = await mkdtemp(join(tmpdir(), 'quimby-merge-msg-'))
  const file = join(dir, 'COMMIT_EDITMSG')
  await writeFile(
    file,
    `${prefill}\n\n` +
      `# Please enter the commit message for the work you're merging.\n` +
      `# Lines starting with '#' are ignored; an empty message or a non-zero editor exit\n` +
      `# (e.g. :cq in vim) cancels the merge.\n`,
  )
  try {
    try {
      // The editor may carry args (e.g. "code --wait"), so run the whole command via a shell.
      await execa(`${editor} "${file}"`, { stdio: 'inherit', shell: true })
    } catch (err) {
      // A non-zero editor exit (e.g. `:cq`) is the user cancelling the merge: signal it with a
      // null sentinel so the caller bails silently. execa surfaces a completed-but-failed
      // process with a numeric exitCode; anything without one is a real spawn error, so rethrow.
      if (typeof (err as { exitCode?: unknown }).exitCode === 'number') return null
      throw err
    }
    const edited = await readFile(file, 'utf8')
    return edited
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
      .trim()
  } finally {
    await rm(dir, { recursive: true, force: true })
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
  /** `--sync <ref>`: retarget the agent's sync ref to this while advancing (else onto its base). */
  retargetRef?: string
}): Promise<void> {
  const { state, repoRoot, agent, name, mergedName, targetRepoPath, landedOnBranch, retargetRef } =
    opts
  const catchUp = `\`quimby sync ${name} --current -f\``
  const syncRef = agent.syncRef ?? state.sourceRef

  // The same gate the pre-sync used, recomputed after the merge: when the merge lands on the
  // tracked branch, HEAD and syncRef move together, so it still holds. A failing gate means
  // the work isn't on syncRef and a hard reset would drop it — defer to the manual catch-up.
  const gate = await mergingOntoTrackedBranch({
    repoRoot,
    targetRepoPath,
    agent,
    fallbackRef: state.sourceRef,
    landedOnBranch,
  })
  if (!gate.ok) {
    if (gate.reason.startsWith('unresolved:')) {
      logger.info(
        `Couldn't resolve "${name}"'s tracked branch (${syncRef}) — catch it up with ${catchUp}.`,
      )
    } else if (gate.reason.startsWith('off-syncref')) {
      logger.info(
        `Merge isn't on "${name}"'s tracked branch (${syncRef}) — catch it up with ${catchUp}.`,
      )
    } else {
      logger.info(`Landed off "${name}"'s tracked branch — catch it up when ready with ${catchUp}.`)
    }
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

  // A ref retargets the agent's sync ref while advancing (syncAgent persists `base`); without
  // one the seed advances onto the current base — the branch the merge just landed on.
  const result = await syncAgent(repoRoot, name, { force: true, base: retargetRef })
  const retargeted = retargetRef ? ` (now tracks ${retargetRef})` : ''
  logger.success(`Advanced "${name}" seed → ${result.newSeed.slice(0, 8)}${retargeted}`)
}

/**
 * Whether a merge is landing on the branch the agent tracks — the shared gate for both the
 * pre-sync (before staging) and the seed post-advance (after landing), so both fire together
 * for the ordinary iterate-on-its-branch case and both stand down for a deliberate off-branch
 * merge. True only when there's no `-b` landing branch, the target is this same host repo, and
 * HEAD resolves to the agent's syncRef tip. Compares git toplevels (not raw paths) so a merge
 * run from a subdirectory still counts as the same repo. The failure reason drives the caller's
 * catch-up message.
 */
async function mergingOntoTrackedBranch(opts: {
  repoRoot: string
  targetRepoPath: string
  agent: Readonly<AgentState>
  fallbackRef: string
  landedOnBranch: boolean
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { repoRoot, targetRepoPath, agent, fallbackRef, landedOnBranch } = opts
  const targetTop = await git.findRoot(targetRepoPath)
  if (landedOnBranch || targetTop !== repoRoot) return { ok: false, reason: 'off-branch' }
  const syncRef = agent.syncRef ?? fallbackRef
  let syncTip: string
  let headTip: string
  try {
    syncTip = await git.revParse(repoRoot, syncRef)
    headTip = await git.revParse(repoRoot, 'HEAD')
  } catch {
    return { ok: false, reason: `unresolved:${syncRef}` }
  }
  if (syncTip !== headTip) return { ok: false, reason: `off-syncref:${syncRef}` }
  return { ok: true }
}
