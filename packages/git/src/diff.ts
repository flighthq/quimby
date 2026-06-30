import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GitError } from '@quimbyhq/errors'
import { execa } from 'execa'

async function runGit(args: string[], cwd: string, opts?: { raw?: boolean }): Promise<string> {
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

export async function am(cwd: string, patchPaths: string[]): Promise<void> {
  await runGit(['am', '--3way', ...patchPaths], cwd)
}

export async function amAbort(cwd: string): Promise<void> {
  await runGit(['am', '--abort'], cwd)
}

export async function apply(
  cwd: string,
  patchPath: string,
  opts?: { check?: boolean },
): Promise<void> {
  const args = ['apply']
  if (opts?.check) args.push('--check')
  args.push(patchPath)
  await runGit(args, cwd)
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

export type DiffApplicationStatus = 'settled' | 'fresh' | 'drifted'

/**
 * Classify each file in a unified diff by how it would land in `cwd`'s current tree:
 * - `fresh` — forward-applies cleanly: genuinely new work
 * - `settled` — reverse-applies cleanly: the file already matches the patch's
 *   post-image, so re-applying is a no-op (shipped work an agent keeps re-sending
 *   against a stale seed)
 * - `drifted` — neither: the target overlaps or diverged from the patch (a real
 *   conflict needing resolution)
 *
 * This is what makes a re-apply legible — it separates "you forgot to sync; this is
 * already shipped" from "two agents touched the same lines", which `git apply`'s raw
 * failure conflates.
 */
export async function classifyDiffApplication(
  cwd: string,
  diffText: string,
): Promise<Record<DiffApplicationStatus, string[]>> {
  const result: Record<DiffApplicationStatus, string[]> = { settled: [], fresh: [], drifted: [] }
  for (const { path, patch } of splitDiffByFile(diffText)) {
    // Order matters: a no-op file forward-applies *and* reverse-applies (an empty
    // change is clean both ways), so test "already present" first.
    if (await canApply(cwd, patch, ['--reverse'])) result.settled.push(path)
    else if (await canApply(cwd, patch, [])) result.fresh.push(path)
    else result.drifted.push(path)
  }
  return result
}

export async function diff(cwd: string, baseRef: string): Promise<string> {
  return runGit(['diff', baseRef], cwd, { raw: true })
}

export async function diffStaged(cwd: string, baseRef: string): Promise<string> {
  return runGit(['diff', '--staged', baseRef], cwd, { raw: true })
}

/**
 * Diff `base` against the full current working tree — committed, uncommitted, and
 * untracked (non-ignored) — without making a commit or touching the repo's real index.
 *
 * Stages everything into a throwaway index (`GIT_INDEX_FILE`), writes a tree from it,
 * and diffs `base` against that tree. This is how work is captured for handoff/apply:
 * the source's history and index are left untouched, so frequent use never litters it.
 * `base` of `HEAD` yields exactly the uncommitted+untracked remainder.
 */
export async function diffWorkingTree(cwd: string, base: string): Promise<string> {
  const indexFile = join(tmpdir(), `quimby-index-${crypto.randomUUID()}`)
  const env = { ...process.env, GIT_INDEX_FILE: indexFile }
  try {
    await execa('git', ['read-tree', base], { cwd, env })
    await execa('git', ['add', '-A'], { cwd, env })
    const { stdout: tree } = await execa('git', ['write-tree'], {
      cwd,
      env,
      stripFinalNewline: true,
    })
    const { stdout } = await execa('git', ['diff', base, tree], { cwd, stripFinalNewline: false })
    return stdout
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    throw new GitError(`git working-tree capture failed: ${e.stderr ?? e.message}`, e.stderr)
  } finally {
    await rm(indexFile, { force: true })
  }
}

/**
 * Reconstruct `diffText` with the named files removed. Used to drop already-settled
 * files from a parcel before applying, so a re-send lands only its unsettled work
 * instead of `git apply` failing wholesale on files already present in the target.
 */
export function filterDiffFiles(diffText: string, dropPaths: readonly string[]): string {
  if (dropPaths.length === 0) return diffText
  const drop = new Set(dropPaths)
  return splitDiffByFile(diffText)
    .filter((file) => !drop.has(file.path))
    .map((file) => file.patch)
    .join('')
}

export async function formatPatch(
  cwd: string,
  baseRef: string,
  outputDir: string,
): Promise<string[]> {
  const stdout = await runGit(['format-patch', baseRef, '-o', outputDir], cwd)
  return stdout.split('\n').filter(Boolean)
}

/** Paths with unresolved merge conflicts in the working tree (empty if none). */
export async function getConflicts(cwd: string): Promise<string[]> {
  const stdout = await runGit(['status', '--porcelain'], cwd)
  return stdout
    .split('\n')
    .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l))
    .map((l) => l.slice(3).trim())
}

/** True if `patch` applies to `cwd` without error under `--check` (with `extraArgs`). */
async function canApply(cwd: string, patch: string, extraArgs: string[]): Promise<boolean> {
  try {
    await execa('git', ['apply', '--check', ...extraArgs, '-'], { cwd, input: patch })
    return true
  } catch {
    return false
  }
}

/**
 * Split a `git diff` into one self-contained patch per file, keyed by the file's
 * post-image path. Splits on `diff --git` headers; the path comes from that header's
 * `b/` side (its pre-image `a/` side for a deletion, where `b/` is `/dev/null`).
 */
function splitDiffByFile(diffText: string): Array<{ path: string; patch: string }> {
  if (!diffText.trim()) return []
  const chunks: string[][] = []
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ') || chunks.length === 0) chunks.push([])
    chunks[chunks.length - 1].push(line)
  }
  return chunks
    .filter((lines) => lines[0]?.startsWith('diff --git '))
    .map((lines) => {
      const patch = lines.join('\n')
      return { path: filePathOfDiff(lines[0]), patch: patch.endsWith('\n') ? patch : `${patch}\n` }
    })
}

/** Extract a readable file path from a `diff --git a/<x> b/<y>` header line. */
function filePathOfDiff(header: string): string {
  const match = header.match(/^diff --git a\/(.+) b\/(.+)$/)
  if (!match) return header
  const [, a, b] = match
  return b === 'dev/null' ? a : b
}
