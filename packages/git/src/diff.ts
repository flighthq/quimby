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

export async function am(
  cwd: string,
  patchPaths: string[],
  opts?: { skipHooks?: boolean },
): Promise<void> {
  const args = ['am', '--3way']
  if (opts?.skipHooks) args.push('--no-verify')
  args.push(...patchPaths)
  await runGit(args, cwd)
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
 *
 * `exclude` names paths kept out of the capture regardless of `.gitignore` — each is
 * matched at the repo root, so passing `.quimby` guarantees Quimby's own state never
 * enters a diff even in a repo whose `.gitignore` lacks the entry.
 */
export async function diffWorkingTree(
  cwd: string,
  base: string,
  opts?: { binary?: boolean; exclude?: readonly string[] },
): Promise<string> {
  return withCapturedTree(cwd, base, opts?.exclude, async (tree) => {
    // `--binary` for capture (so a carried/applied diff can recreate binary files);
    // omitted for display, where it would spew base85 instead of "Binary files differ".
    const args = ['diff', ...(opts?.binary ? ['--binary'] : []), base, tree]
    const { stdout } = await execa('git', args, { cwd, stripFinalNewline: false })
    return stdout
  })
}

/**
 * Line-delta summary of the same working-tree capture {@link diffWorkingTree} produces —
 * committed + uncommitted + untracked (non-ignored) against `base`, without touching the
 * repo's real index. Returns changed-file count and total insertions/deletions; binary
 * files count toward `files` but contribute no line deltas (git reports them as `-`). This
 * is the cheap "N files, +X/−Y vs seed" merge-state signal, sharing one capture with the
 * full diff so the numbers always match what a handoff/apply would carry.
 */
export async function diffWorkingTreeNumstat(
  cwd: string,
  base: string,
  opts?: { exclude?: readonly string[] },
): Promise<WorkingTreeStat> {
  return withCapturedTree(cwd, base, opts?.exclude, async (tree) => {
    const { stdout } = await execa('git', ['diff', '--numstat', base, tree], {
      cwd,
      stripFinalNewline: true,
    })
    return parseNumstat(stdout)
  })
}

export async function formatPatch(
  cwd: string,
  baseRef: string,
  outputDir: string,
): Promise<string[]> {
  // `--binary` so replayed commits (git am) can recreate binary files, not just text.
  const stdout = await runGit(['format-patch', '--binary', baseRef, '-o', outputDir], cwd)
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

/** Changed-file count and total line deltas of a working-tree capture against a base. */
export interface WorkingTreeStat {
  files: number
  insertions: number
  deletions: number
}

/**
 * Stage the full working tree (committed + uncommitted + untracked) into a throwaway index,
 * write a tree from it, and hand that tree to `use` — the shared capture behind both
 * {@link diffWorkingTree} and {@link diffWorkingTreeNumstat}. The repo's real index and
 * history are never touched. `exclude` drops repo-root paths from the capture regardless of
 * `.gitignore` (so `.quimby` never leaks), skipping any path already tracked in `base` to
 * avoid showing a spurious deletion.
 */
async function withCapturedTree<T>(
  cwd: string,
  base: string,
  exclude: readonly string[] | undefined,
  use: (tree: string) => Promise<T>,
): Promise<T> {
  const indexFile = join(tmpdir(), `quimby-index-${crypto.randomUUID()}`)
  const env = { ...process.env, GIT_INDEX_FILE: indexFile }
  try {
    await execa('git', ['read-tree', base], { cwd, env })
    await execa('git', ['add', '-A'], { cwd, env })
    // A pathspec on `add` can't exclude (it errors on an ignored match), so stage all then
    // unstage. Skipped when the path is tracked in `base`, so a real tracked path stays put.
    for (const path of exclude ?? []) {
      const inBase = await execa('git', ['ls-tree', base, '--', path], { cwd, env })
      if (inBase.stdout.trim()) continue
      await execa('git', ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', path], {
        cwd,
        env,
      })
    }
    const { stdout: tree } = await execa('git', ['write-tree'], {
      cwd,
      env,
      stripFinalNewline: true,
    })
    return await use(tree)
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    throw new GitError(`git working-tree capture failed: ${e.stderr ?? e.message}`, e.stderr)
  } finally {
    await rm(indexFile, { force: true })
  }
}

function parseNumstat(numstat: string): WorkingTreeStat {
  let files = 0
  let insertions = 0
  let deletions = 0
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    files++
    const [ins, del] = line.split('\t')
    // Binary files report "-\t-" — they count as a changed file but add no line deltas.
    if (ins !== '-') insertions += parseInt(ins, 10) || 0
    if (del !== '-') deletions += parseInt(del, 10) || 0
  }
  return { files, insertions, deletions }
}
