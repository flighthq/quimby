import { rm } from 'node:fs/promises'

import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import {
  getAgentDir,
  getAgentHandoffInProcessedDir,
  getAgentHandoffOutSentDir,
  getAgentRepoDir,
  QUIMBY_DIRNAME,
  remoteAgentDir,
  remoteAgentHandoffInProcessedDir,
  remoteAgentHandoffOutSentDir,
  remoteAgentRepoDir,
  remoteProjectRoot,
} from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import type { SSHTransport } from '@quimbyhq/transport'
import { getSSHTransport } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { loadState, saveState } from '@quimbyhq/workspace'

import { writeAgentInstructions, writeRemoteAgentInstructions } from './lifecycle'
import type { RepoSyncOps } from './syncAlgorithm'
import { runSyncAlgorithm } from './syncAlgorithm'

export async function getAgentPendingWork(
  repoRoot: string,
  stateId: string,
  agent: Readonly<AgentState>,
): Promise<{ commits: number; dirty: boolean } | null> {
  try {
    if (isSSH(agent.location)) {
      const transport = getSSHTransport(agent.location)
      const rRepoDir = remoteAgentRepoDir(stateId, agent.id, agent.location.base)
      const [countOut, statusOut] = await Promise.all([
        transport.exec(`git rev-list --count quimby/seed..HEAD`, { cwd: rRepoDir }),
        transport.exec(`git status --porcelain`, { cwd: rRepoDir }),
      ])
      return {
        commits: parseInt(countOut.trim(), 10) || 0,
        dirty: statusOut.trim().length > 0,
      }
    }

    const repoDir = getAgentRepoDir(repoRoot, agent.id)
    const [commits, clean] = await Promise.all([
      git.countCommits(repoDir, 'quimby/seed..HEAD'),
      git.isClean(repoDir),
    ])
    return { commits, dirty: !clean }
  } catch {
    return null
  }
}

export async function getAgentSyncStatus(
  repoRoot: string,
  agent: Readonly<AgentState>,
  fallback: string,
): Promise<{ behind: number; syncRef: string; targetCommit: string }> {
  const syncRef = agent.syncRef ?? fallback
  const targetCommit = await resolveSyncTarget(repoRoot, agent, fallback)
  if (!agent.seedCommit || agent.seedCommit === targetCommit) {
    return { behind: 0, syncRef, targetCommit }
  }
  const behind = await git.countCommits(repoRoot, `${agent.seedCommit}..${targetCommit}`)
  return { behind, syncRef, targetCommit }
}

/** The cheap merge-state signal: how much unmerged work sits on an agent's seed. */
export interface AgentWorkSummary {
  /** Changed files vs `quimby/seed` (committed + uncommitted + untracked). */
  files: number
  insertions: number
  deletions: number
  /** Commits on the agent's branch since its seed (`quimby/seed..HEAD`). */
  commits: number
}

/**
 * Compute an agent's {@link AgentWorkSummary} — changed files, ±lines, and commit count of
 * its working tree against `quimby/seed`. `files === 0 && commits === 0` means "synced"
 * (nothing unmerged). Shares the working-tree capture with `diff`/handoff so the numbers
 * match what an apply would carry. Returns null when the repo can't be read (agent never
 * provisioned, or an unreachable SSH host).
 */
export async function getAgentWorkSummary(
  repoRoot: string,
  stateId: string,
  agent: Readonly<AgentState>,
): Promise<AgentWorkSummary | null> {
  try {
    if (isSSH(agent.location)) {
      const transport = getSSHTransport(agent.location)
      const rRepoDir = remoteAgentRepoDir(stateId, agent.id, agent.location.base)
      const [numstatOut, othersOut, countOut] = await Promise.all([
        transport.exec(`git diff --numstat quimby/seed`, { cwd: rRepoDir }),
        transport.exec(`git ls-files --others --exclude-standard`, { cwd: rRepoDir }),
        transport.exec(`git rev-list --count quimby/seed..HEAD`, { cwd: rRepoDir }),
      ])
      const tracked = parseNumstat(numstatOut)
      const untracked = othersOut.split('\n').filter(Boolean).length
      return {
        files: tracked.files + untracked,
        insertions: tracked.insertions,
        deletions: tracked.deletions,
        commits: parseInt(countOut.trim(), 10) || 0,
      }
    }

    const repoDir = getAgentRepoDir(repoRoot, agent.id)
    const [stat, commits] = await Promise.all([
      git.diffWorkingTreeNumstat(repoDir, 'quimby/seed', { exclude: [QUIMBY_DIRNAME] }),
      git.countCommits(repoDir, 'quimby/seed..HEAD'),
    ])
    return { files: stat.files, insertions: stat.insertions, deletions: stat.deletions, commits }
  } catch {
    return null
  }
}

/**
 * The agent's commit subjects since its seed (`quimby/seed..HEAD`), newest first — the one-line
 * `<sha> <subject>` log that `diff` and `merge --preview` show above the diff. Empty when there are
 * none (uncommitted-only work) or the repo can't be read (unprovisioned / unreachable SSH host).
 */
export async function getAgentCommitSubjects(
  repoRoot: string,
  stateId: string,
  agent: Readonly<AgentState>,
): Promise<string[]> {
  try {
    if (isSSH(agent.location)) {
      const transport = getSSHTransport(agent.location)
      const rRepoDir = remoteAgentRepoDir(stateId, agent.id, agent.location.base)
      const out = await transport.exec(`git log quimby/seed..HEAD --format=%h %s`, {
        cwd: rRepoDir,
      })
      return out.split('\n').filter(Boolean)
    }
    const repoDir = getAgentRepoDir(repoRoot, agent.id)
    return (await git.log(repoDir, 'quimby/seed..HEAD', '%h %s')).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Sync an agent onto its base as a pre-packaging step (a `--rebase` before handoff,
 * dispatch, or merge), narrating the outcome. Thin wrapper over {@link syncAgent} that
 * exists so callers in other packages get the friendly progress + result without
 * re-implementing the log lines; supplied as the `beforeStage` callback by the CLI.
 */
export async function rebaseAgentOntoBase(
  repoRoot: string,
  name: string,
  reporter: Reporter = silentReporter,
): Promise<{ newSeed: string; rebased: boolean; commitsReplayed: number }> {
  reporter.start(`Syncing "${name}" onto its base`)
  const result = await syncAgent(repoRoot, name)
  if (result.rebased) {
    reporter.success(
      `Rebased ${result.commitsReplayed} commit(s) onto ${result.newSeed.slice(0, 8)}`,
    )
  } else {
    reporter.info(`Already based on host HEAD (${result.newSeed.slice(0, 8)})`)
  }
  return result
}

export async function syncAgent(
  repoRoot: string,
  name: string,
  opts?: { force?: boolean; base?: string },
): Promise<{ newSeed: string; rebased: boolean; commitsReplayed: number }> {
  const state = await loadState(repoRoot)

  if (!Object.hasOwn(state.agents, name)) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }

  // --base retargets the agent's recorded sync ref (persisted), then syncs onto it.
  if (opts?.base) {
    state.agents[name].syncRef = opts.base
    await saveState(repoRoot, state)
  }

  const agent = state.agents[name]
  const hostHead = await resolveSyncTarget(repoRoot, agent, state.sourceRef)

  let ops: RepoSyncOps
  if (isSSH(agent.location)) {
    const transport = getSSHTransport(agent.location)
    // Push the latest project to the remote before advancing the agent onto it.
    await transport.syncProjectTo(repoRoot, remoteProjectRoot(state.id, agent.location.base))
    ops = remoteSyncOps(transport, remoteAgentRepoDir(state.id, agent.id, agent.location.base))
  } else {
    ops = localSyncOps(getAgentRepoDir(repoRoot, agent.id))
  }

  const result = await runSyncAlgorithm(ops, {
    hostHead,
    seedCommit: agent.seedCommit,
    force: opts?.force,
    name,
  })

  state.agents[name].seedCommit = result.newSeed
  await saveState(repoRoot, state)

  // Re-render the Quimby-tier scaffold onto the agent's on-disk dir as part of the sync, so
  // upgrading quimby reaches an in-flight agent without a rebuild or a session kill. Best-effort:
  // a write failure never fails the sync.
  await refreshAgentScaffold(repoRoot, state.id, agent).catch(() => {})

  // GC the delivery/processing caches now that the agent has advanced — folded into sync per
  // the courier-not-post-office model. Best-effort: a prune failure never fails the sync.
  await pruneAgentMailboxCaches(repoRoot, agent, state.id).catch(() => {})

  return result
}

/**
 * Prune an agent's mailbox caches — the `handoff/out/sent/` delivery ledger and the
 * `handoff/in/processed/` archive. These are caches bounded by agent lifetime, not the hot path,
 * so GC is folded into `sync` (and covered by `rebuild`'s full mailbox wipe). Active queued/
 * received parcels, `assignment.md`, and `status.md` are left untouched — this only sweeps the
 * archives.
 */
export async function pruneAgentMailboxCaches(
  repoRoot: string,
  agent: Readonly<AgentState>,
  stateId: string,
): Promise<void> {
  if (isSSH(agent.location)) {
    const base = agent.location.base
    await getSSHTransport(agent.location).exec(
      `rm -rf ${remoteAgentHandoffOutSentDir(stateId, agent.id, base)} ${remoteAgentHandoffInProcessedDir(stateId, agent.id, base)}`,
    )
    return
  }
  await rm(getAgentHandoffOutSentDir(repoRoot, agent.id), { recursive: true, force: true })
  await rm(getAgentHandoffInProcessedDir(repoRoot, agent.id), { recursive: true, force: true })
}

/**
 * Re-render an agent's Quimby-tier scaffold — `CLAUDE.md`/`AGENTS.md` and the `agent.sh`/`.cmd`
 * coordination tool — onto its current on-disk agent dir (host, or remote over transport). Folded
 * into `sync` so a `quimby` upgrade reaches an in-flight agent without a rebuild or a session kill:
 * it rewrites only the generated instruction/tool files — never `assignment.md`, `status.md`, or the
 * mailbox — and never touches the tmux session or sandbox, so the running agent keeps working and
 * ingests the new docs at its next context reset. The runtime hint is the agent's stored default; a
 * later launch re-renders with the fully-resolved runtime.
 */
async function refreshAgentScaffold(
  repoRoot: string,
  stateId: string,
  agent: Readonly<AgentState>,
): Promise<void> {
  const opts = { agentName: agent.name, agentId: agent.id, runtime: agent.defaults?.runtime }
  if (isSSH(agent.location)) {
    await writeRemoteAgentInstructions(
      getSSHTransport(agent.location),
      remoteAgentDir(stateId, agent.id, agent.location.base),
      opts,
    )
    return
  }
  await writeAgentInstructions(getAgentDir(repoRoot, agent.id), opts)
}

/** Drive the sync algorithm against a local agent clone via the git CLI. */
function localSyncOps(repoDir: string): RepoSyncOps {
  return {
    fetch: () => git.fetch(repoDir, 'origin'),
    countCommitsSinceSeed: async () =>
      (await git.log(repoDir, 'quimby/seed..HEAD', '%H')).split('\n').filter(Boolean).length,
    pendingConflictState: async () => {
      if (await git.isRebaseOrAmInProgress(repoDir)) return 'rebase'
      if (await git.isMergeInProgress(repoDir)) return 'merge'
      if (await git.hasUnmergedPaths(repoDir)) return 'unmerged'
      return null
    },
    isDirty: async () => !(await git.isClean(repoDir)),
    stash: async () => {
      await git.stash(repoDir)
    },
    resetHardTo: (commit) => git.resetHard(repoDir, commit),
    rebaseOnto: (commit) => git.rebase(repoDir, commit),
    rebaseAbort: async () => {
      await git.rebaseAbort(repoDir)
      return !(await git.isRebaseOrAmInProgress(repoDir))
    },
    tagSeed: (commit) => git.tagForce(repoDir, 'quimby/seed', commit),
    stashPop: () => git.stashPop(repoDir),
  }
}

/** Drive the sync algorithm against an SSH agent's remote clone via `git` over transport. */
function remoteSyncOps(transport: SSHTransport, rRepoDir: string): RepoSyncOps {
  const cwd = { cwd: rRepoDir }
  // Mirrors git.isRebaseOrAmInProgress: a rebase marks progress with a rebase-merge/rebase-apply
  // dir (resolved via --git-path so it holds for worktrees), neither being a single ref to verify.
  const rebaseInProgress =
    '[ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]'
  return {
    fetch: async () => {
      await transport.exec(`git fetch origin`, cwd)
    },
    countCommitsSinceSeed: async () =>
      (await transport.exec(`git log quimby/seed..HEAD --format=%H`, cwd))
        .split('\n')
        .filter(Boolean).length,
    pendingConflictState: async () => {
      const out = await transport.exec(
        `if ${rebaseInProgress}; then echo rebase; ` +
          `elif git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then echo merge; ` +
          `elif [ -n "$(git ls-files --unmerged)" ]; then echo unmerged; ` +
          `else echo clean; fi`,
        cwd,
      )
      const s = out.trim()
      return s === 'rebase' || s === 'merge' || s === 'unmerged' ? s : null
    },
    isDirty: async () => (await transport.exec(`git status --porcelain`, cwd)).trim().length > 0,
    stash: async () => {
      await transport.exec(`git stash push --include-untracked -m quimby-sync`, cwd)
    },
    resetHardTo: async (commit) => {
      await transport.exec(`git reset --hard ${commit}`, cwd)
    },
    rebaseOnto: async (commit) => {
      await transport.exec(`git rebase ${commit}`, cwd)
    },
    rebaseAbort: async () => {
      await transport.exec(`git rebase --abort`, cwd).catch(() => {})
      const out = await transport
        .exec(`if ${rebaseInProgress}; then echo yes; else echo no; fi`, cwd)
        .catch(() => 'yes')
      return out.trim() === 'no'
    },
    tagSeed: async (commit) => {
      await transport.exec(`git tag -f quimby/seed ${commit}`, cwd)
    },
    stashPop: async () => {
      await transport.exec(`git stash pop`, cwd)
    },
  }
}

/**
 * Resolve the commit an agent should advance onto: the tip of its recorded
 * `syncRef` (falling back to the workspace `sourceRef` for agents created
 * before sync targets existed). Resolution happens in the host repo, so the
 * result is deterministic regardless of what the host is checked out to.
 */
async function resolveSyncTarget(
  repoRoot: string,
  agent: AgentState,
  fallback: string,
): Promise<string> {
  const ref = agent.syncRef ?? fallback
  try {
    return await git.revParse(repoRoot, ref)
  } catch {
    throw new QuimbyError(
      `Agent "${agent.name}" syncs against "${ref}", which doesn't resolve in the host repo. ` +
        `Retarget it with "quimby set ${agent.name} --sync <ref>".`,
    )
  }
}

/** Sum a `git diff --numstat` block (remote SSH path) into file/insertion/deletion counts. */
function parseNumstat(numstat: string): { files: number; insertions: number; deletions: number } {
  let files = 0
  let insertions = 0
  let deletions = 0
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    files++
    const [ins, del] = line.split('\t')
    // Binary files report "-\t-": counted as a changed file, no line deltas.
    if (ins !== '-') insertions += parseInt(ins, 10) || 0
    if (del !== '-') deletions += parseInt(del, 10) || 0
  }
  return { files, insertions, deletions }
}
