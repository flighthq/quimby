import { GitError } from '@quimbyhq/errors'
import { execa } from 'execa'

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

export async function init(cwd: string): Promise<void> {
  await git(['init'], cwd)
}

export async function addAll(cwd: string): Promise<void> {
  await git(['add', '-A'], cwd)
}

export async function commit(cwd: string, message: string): Promise<void> {
  await git(['commit', '-m', message], cwd)
}

export async function tag(cwd: string, name: string): Promise<void> {
  await git(['tag', name], cwd)
}

export async function formatPatch(
  cwd: string,
  baseRef: string,
  outputDir: string,
): Promise<string[]> {
  const stdout = await git(['format-patch', baseRef, '-o', outputDir], cwd)
  return stdout.split('\n').filter(Boolean)
}

export async function diff(cwd: string, baseRef: string): Promise<string> {
  return git(['diff', baseRef], cwd, { raw: true })
}

export async function diffStaged(cwd: string, baseRef: string): Promise<string> {
  return git(['diff', '--staged', baseRef], cwd, { raw: true })
}

export async function apply(
  cwd: string,
  patchPath: string,
  opts?: { check?: boolean },
): Promise<void> {
  const args = ['apply']
  if (opts?.check) args.push('--check')
  args.push(patchPath)
  await git(args, cwd)
}

/**
 * Apply a patch with 3-way merge fallback. Returns conflicted file paths on partial
 * success; empty array means clean apply. Throws GitError on total failure (patch
 * could not be applied at all, e.g. malformed diff or missing blobs).
 */
export async function applyThreeWay(cwd: string, patchPath: string): Promise<string[]> {
  try {
    await execa('git', ['apply', '--3way', patchPath], { cwd, stripFinalNewline: true })
    return []
  } catch {
    // Distinguish partial apply with conflicts from complete failure
    try {
      const { stdout } = await execa('git', ['status', '--porcelain'], {
        cwd,
        stripFinalNewline: true,
      })
      const conflicts = stdout
        .split('\n')
        .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l))
        .map((l) => l.slice(3).trim())
      if (conflicts.length > 0) return conflicts
    } catch {}
    throw new GitError('git apply --3way failed: patch could not be applied', undefined)
  }
}

export async function am(cwd: string, patchPaths: string[]): Promise<void> {
  await git(['am', '--3way', ...patchPaths], cwd)
}

export async function amAbort(cwd: string): Promise<void> {
  await git(['am', '--abort'], cwd)
}

export async function log(cwd: string, range: string, format?: string): Promise<string> {
  return git(['log', range, `--format=${format ?? '%H|%s|%an|%aI'}`], cwd)
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  const stdout = await git(['rev-parse', ref], cwd)
  return stdout.trim()
}

export async function isClean(cwd: string): Promise<boolean> {
  const stdout = await git(['status', '--porcelain'], cwd)
  return stdout.trim() === ''
}

/** Paths with unresolved merge conflicts in the working tree (empty if none). */
export async function getConflicts(cwd: string): Promise<string[]> {
  const stdout = await git(['status', '--porcelain'], cwd)
  return stdout
    .split('\n')
    .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l))
    .map((l) => l.slice(3).trim())
}

export async function createBranch(cwd: string, name: string): Promise<void> {
  await git(['checkout', '-b', name], cwd)
}

export async function deleteBranch(cwd: string, name: string): Promise<void> {
  await git(['branch', '-D', name], cwd)
}

export async function branchExists(cwd: string, name: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', name], cwd)
    return true
  } catch {
    return false
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

export async function setConfig(cwd: string, key: string, value: string): Promise<void> {
  await git(['config', key, value], cwd)
}

export async function getRemoteUrl(cwd: string): Promise<string | undefined> {
  try {
    const stdout = await git(['remote', 'get-url', 'origin'], cwd)
    return stdout.trim()
  } catch {
    return undefined
  }
}

export async function getCurrentRef(cwd: string): Promise<string> {
  const stdout = await git(['rev-parse', 'HEAD'], cwd)
  return stdout.trim()
}

export async function findRoot(cwd: string): Promise<string | undefined> {
  try {
    const stdout = await git(['rev-parse', '--show-toplevel'], cwd)
    return stdout.trim()
  } catch {
    return undefined
  }
}

export async function fetch(cwd: string, remote?: string, opts?: { ref?: string }): Promise<void> {
  const args = ['fetch']
  if (remote) args.push(remote)
  if (opts?.ref) args.push(opts.ref)
  await git(args, cwd)
}

export async function checkout(cwd: string, ref: string): Promise<void> {
  await git(['checkout', ref], cwd)
}

export async function tagForce(cwd: string, name: string, ref?: string): Promise<void> {
  const args = ['tag', '-f', name]
  if (ref) args.push(ref)
  await git(args, cwd)
}

export async function rebase(cwd: string, onto: string): Promise<void> {
  await git(['rebase', onto], cwd)
}

export async function rebaseAbort(cwd: string): Promise<void> {
  try {
    await git(['rebase', '--abort'], cwd)
  } catch {}
}

export async function stash(cwd: string): Promise<boolean> {
  const before = await git(['stash', 'list'], cwd)
  await git(['stash', 'push', '-m', 'ao-refresh'], cwd)
  const after = await git(['stash', 'list'], cwd)
  return before !== after
}

export async function stashPop(cwd: string): Promise<void> {
  await git(['stash', 'pop'], cwd)
}

export async function resetHard(cwd: string, ref: string): Promise<void> {
  await git(['reset', '--hard', ref], cwd)
}

export async function hasCommitsSince(cwd: string, baseRef: string): Promise<boolean> {
  const stdout = await git(['rev-list', '--count', `${baseRef}..HEAD`], cwd)
  return parseInt(stdout.trim(), 10) > 0
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

export async function addRemote(cwd: string, name: string, url: string): Promise<void> {
  await git(['remote', 'add', name, url], cwd)
}

export async function hasRemote(cwd: string, name: string): Promise<boolean> {
  try {
    await git(['remote', 'get-url', name], cwd)
    return true
  } catch {
    return false
  }
}
