import { mkdir, rm, stat, writeFile } from 'node:fs/promises'

import { join } from 'pathe'

export interface DirLockOptions {
  /**
   * How long to keep trying before giving up. `0` (the default) yields immediately, which is right
   * when the loser's work will be redone anyway on its next cycle; a positive value is for work a
   * user asked for explicitly, where doing nothing is worse than waiting.
   */
  waitMs?: number
  /**
   * A lock older than this is treated as abandoned by a crashed process. Deliberately far longer
   * than any real operation, so a slow rsync is never stolen from a live holder.
   */
  staleAfterMs?: number
}

/**
 * Run `fn` holding an exclusive, **cross-process** lock on `lockDir`, or return `null` when the
 * lock could not be taken.
 *
 * Quimby's processes serialize their own work but not each other's: a poll cycle inside
 * `quimby serve` and a `quimby sync`/`dispatch` the user just typed are different processes
 * reaching for the same files. An in-process mutex cannot see across that boundary; a directory in
 * the filesystem can, because `mkdir` of an existing path fails atomically on every platform
 * quimby runs on.
 *
 * Takes an absolute path rather than a workspace + key so this stays a domain-less helper — the
 * callers own what a lock is *for* and compute its dir from `@quimbyhq/paths`.
 */
export async function withDirLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  opts?: Readonly<DirLockOptions>,
): Promise<T | null> {
  if (!(await acquireDirLock(lockDir, opts))) return null
  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function acquireDirLock(lockDir: string, opts?: Readonly<DirLockOptions>): Promise<boolean> {
  const staleAfterMs = opts?.staleAfterMs ?? STALE_AFTER_MS
  const deadline = Date.now() + (opts?.waitMs ?? 0)
  await mkdir(dirnameOf(lockDir), { recursive: true }).catch(() => {})
  for (;;) {
    if (await tryMkdir(lockDir)) return true
    // Reclaim a lock whose holder died. Without this a crash mid-operation wedges that key forever
    // — strictly worse than the race the lock prevents, since the race is recoverable.
    if (await takeOverIfStale(lockDir, staleAfterMs)) {
      if (await tryMkdir(lockDir)) return true
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

async function tryMkdir(lockDir: string): Promise<boolean> {
  // `mkdir` without `recursive` is the atomic test-and-set: it throws EEXIST if the directory is
  // already there, so exactly one caller can win, with no read-then-write window to race in.
  try {
    await mkdir(lockDir)
    await writeFile(join(lockDir, 'owner'), `${process.pid}\n`).catch(() => {})
    return true
  } catch {
    return false
  }
}

async function takeOverIfStale(lockDir: string, staleAfterMs: number): Promise<boolean> {
  try {
    const age = Date.now() - (await stat(lockDir)).mtimeMs
    if (age < staleAfterMs) return false
    await rm(lockDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function dirnameOf(path: string): string {
  const cut = path.replace(/[/\\]+$/, '').lastIndexOf('/')
  return cut <= 0 ? path : path.slice(0, cut)
}

/** A lock older than this is treated as abandoned by a crashed process. */
const STALE_AFTER_MS = 15 * 60 * 1000

/** How often a waiting caller re-tries the atomic `mkdir`. */
const POLL_INTERVAL_MS = 100
