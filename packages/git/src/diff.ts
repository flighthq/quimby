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
