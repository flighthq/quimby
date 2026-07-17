import { access } from 'node:fs/promises'

import { GitError } from '@quimbyhq/errors'
import { execa } from 'execa'
import { isAbsolute, join } from 'pathe'

async function git(args: string[], cwd: string, opts?: { raw?: boolean }): Promise<string> {
  try {
    const { stdout } = await execa('git', args, {
      cwd,
      stripFinalNewline: !opts?.raw,
    })
    return stdout
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    throw new GitError(`git ${args[0]} failed: ${e.stderr ?? e.message}`, e.stderr)
  }
}

export async function addAll(cwd: string, opts?: { exclude?: readonly string[] }): Promise<void> {
  // Bare `git add -A` (no pathspec) silently skips `.gitignore`d paths and exits 0. An
  // explicit pathspec instead — even one whose only intent is a `:(exclude)` — turns a
  // matched-but-ignored path into a hard exit-1 error ("paths are ignored by .gitignore"),
  // which neither `advice.addIgnoredFile=false` nor `--ignore-errors` suppresses. So stage
  // with the bare form, then unstage the excluded paths: this keeps Quimby's own state
  // (`.quimby`) out of a temp-branch commit both when it is ignored (skipped by `add`) and
  // when applying against a seed whose `.gitignore` predates it (staged by `add`, then reset
  // back out). The `:(top)` prefix anchors each path at the repo root so it holds when the
  // command runs from a subdirectory. `git reset` only touches the index, never the working
  // tree, and no-ops cleanly when the path matched nothing.
  await git(['add', '-A'], cwd)
  if (opts?.exclude?.length) {
    await git(['reset', '-q', '--', ...opts.exclude.map((p) => `:(top)${p}`)], cwd)
  }
}

export async function addRemote(cwd: string, name: string, url: string): Promise<void> {
  await git(['remote', 'add', name, url], cwd)
}

export async function branchExists(cwd: string, name: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', name], cwd)
    return true
  } catch {
    return false
  }
}

export async function checkout(cwd: string, ref: string): Promise<void> {
  await git(['checkout', ref], cwd)
}

export interface CherryCommit {
  /** True when the commit has an equivalent patch already reachable from upstream. */
  equivalent: boolean
  sha: string
}

export async function cherry(
  cwd: string,
  upstream: string,
  head: string,
  limit?: string,
): Promise<CherryCommit[]> {
  const args = ['cherry', upstream, head]
  if (limit) args.push(limit)
  const stdout = await git(args, cwd)
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      equivalent: line.startsWith('-'),
      sha: line.slice(2),
    }))
}

export async function clone(
  url: string,
  dest: string,
  opts?: { ref?: string; depth?: number },
): Promise<void> {
  const args = ['clone']
  if (opts?.depth) args.push('--depth', String(opts.depth))
  if (opts?.ref) args.push('--branch', opts.ref)
  args.push(url, dest)
  await execa('git', args)
}

export async function commit(
  cwd: string,
  message: string,
  opts?: { skipHooks?: boolean },
): Promise<void> {
  const args = ['commit', '-m', message]
  if (opts?.skipHooks) args.push('--no-verify')
  await git(args, cwd)
}

/**
 * Count commits in a revision range (e.g. "seed..HEAD"). Returns 0 when either
 * endpoint is unknown or unreachable, so callers can treat it as "nothing to do"
 * rather than handling an error.
 */
export async function countCommits(cwd: string, range: string): Promise<number> {
  try {
    const stdout = await git(['rev-list', '--count', range], cwd)
    return parseInt(stdout.trim(), 10) || 0
  } catch {
    return 0
  }
}

export async function createBranch(cwd: string, name: string, startPoint?: string): Promise<void> {
  const args = ['checkout', '-b', name]
  if (startPoint) args.push(startPoint)
  await git(args, cwd)
}

export async function deleteBranch(cwd: string, name: string): Promise<void> {
  await git(['branch', '-D', name], cwd)
}

export async function fetch(cwd: string, remote?: string, opts?: { ref?: string }): Promise<void> {
  const args = ['fetch']
  if (remote) args.push(remote)
  if (opts?.ref) args.push(opts.ref)
  await git(args, cwd)
}

export async function findRoot(cwd: string): Promise<string | undefined> {
  try {
    const stdout = await git(['rev-parse', '--show-toplevel'], cwd)
    return stdout.trim()
  } catch {
    return undefined
  }
}

export async function getConfig(cwd: string, key: string): Promise<string | undefined> {
  try {
    const stdout = await git(['config', '--get', key], cwd)
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/** The checked-out branch name, or undefined on a detached HEAD (no branch to name). */
export async function getCurrentBranch(cwd: string): Promise<string | undefined> {
  try {
    const stdout = await git(['symbolic-ref', '--short', 'HEAD'], cwd)
    return stdout.trim()
  } catch {
    return undefined
  }
}

export async function getCurrentRef(cwd: string): Promise<string> {
  const stdout = await git(['rev-parse', 'HEAD'], cwd)
  return stdout.trim()
}

export async function getRemoteUrl(cwd: string): Promise<string | undefined> {
  try {
    const stdout = await git(['remote', 'get-url', 'origin'], cwd)
    return stdout.trim()
  } catch {
    return undefined
  }
}

export async function hasCommitsSince(cwd: string, baseRef: string): Promise<boolean> {
  const stdout = await git(['rev-list', '--count', `${baseRef}..HEAD`], cwd)
  return parseInt(stdout.trim(), 10) > 0
}

export async function hasRemote(cwd: string, name: string): Promise<boolean> {
  try {
    await git(['remote', 'get-url', name], cwd)
    return true
  } catch {
    return false
  }
}

export async function merge(
  cwd: string,
  ref: string,
  opts?: { squash?: boolean; noCommit?: boolean; noFf?: boolean; message?: string },
): Promise<void> {
  const args = ['merge']
  if (opts?.squash) args.push('--squash')
  if (opts?.noCommit) args.push('--no-commit')
  if (opts?.noFf) args.push('--no-ff')
  if (opts?.message) args.push('-m', opts.message)
  args.push(ref)
  await git(args, cwd)
}

export async function mergeAbort(cwd: string): Promise<void> {
  await git(['merge', '--abort'], cwd)
}

export async function init(cwd: string): Promise<void> {
  await git(['init'], cwd)
}

export async function isClean(cwd: string): Promise<boolean> {
  const stdout = await git(['status', '--porcelain'], cwd)
  return stdout.trim() === ''
}

export async function isMergeInProgress(cwd: string): Promise<boolean> {
  // A merge in progress is marked by MERGE_HEAD; `rev-parse -q --verify` exits non-zero (and
  // the wrapper throws) when it is absent, so a caught error means "no merge in progress".
  try {
    await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd)
    return true
  } catch {
    return false
  }
}

export async function isRebaseOrAmInProgress(cwd: string): Promise<boolean> {
  // A `git am` (and an old-style rebase) marks progress with a `rebase-apply` directory; an
  // interactive/merge rebase with `rebase-merge`. Neither sets a single ref like MERGE_HEAD, so
  // detection is directory presence — resolved through `--git-path` so it holds for worktrees and
  // submodules. Callers use this exactly as `isMergeInProgress` guards a mid-merge: to avoid
  // clobbering a live retry state.
  for (const marker of ['rebase-apply', 'rebase-merge']) {
    const rel = (await git(['rev-parse', '--git-path', marker], cwd)).trim()
    const dir = isAbsolute(rel) ? rel : join(cwd, rel)
    try {
      await access(dir)
      return true
    } catch {
      // marker absent — check the next one
    }
  }
  return false
}

export async function log(cwd: string, range: string, format?: string): Promise<string> {
  return git(['log', range, `--format=${format ?? '%H|%s|%an|%aI'}`], cwd)
}

export async function rebase(cwd: string, onto: string): Promise<void> {
  await git(['rebase', onto], cwd)
}

export async function rebaseAbort(cwd: string): Promise<void> {
  try {
    await git(['rebase', '--abort'], cwd)
  } catch {}
}

export async function resetHard(cwd: string, ref: string): Promise<void> {
  await git(['reset', '--hard', ref], cwd)
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  const stdout = await git(['rev-parse', ref], cwd)
  return stdout.trim()
}

export async function setConfig(cwd: string, key: string, value: string): Promise<void> {
  await git(['config', key, value], cwd)
}

export async function stash(cwd: string): Promise<boolean> {
  const before = await git(['stash', 'list'], cwd)
  await git(['stash', 'push', '--include-untracked', '-m', 'quimby-sync'], cwd)
  const after = await git(['stash', 'list'], cwd)
  return before !== after
}

export async function stashPop(cwd: string): Promise<void> {
  await git(['stash', 'pop'], cwd)
}

export async function tag(cwd: string, name: string): Promise<void> {
  await git(['tag', name], cwd)
}

export async function tagForce(cwd: string, name: string, ref?: string): Promise<void> {
  const args = ['tag', '-f', name]
  if (ref) args.push(ref)
  await git(args, cwd)
}
