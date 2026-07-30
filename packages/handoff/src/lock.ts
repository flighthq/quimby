import { mkdir, rm, stat, writeFile } from 'node:fs/promises'

import { getLocksDir, getParcelLockDir } from '@quimbyhq/paths'
import { join } from 'pathe'

/**
 * Run `fn` holding an exclusive, **cross-process** lock on one parcel, or report that someone else
 * holds it. Returns `null` instead of running when the lock could not be taken.
 *
 * The server serializes its own poll cycles, but that only stops it racing *itself*: a manual
 * `quimby dispatch` runs in a different process, and both carry through the same shared
 * `.quimby/staging/<parcel>/` — where assembly opens by `rm -rf`-ing the directory. One side
 * therefore deletes the tree the other is mid-rsync into (`mkstemp … No such file or directory`).
 * An in-process mutex cannot see across that boundary; a directory in the filesystem can, because
 * `mkdir` of an existing path fails atomically on every platform quimby runs on.
 *
 * Contention **yields immediately rather than waiting**. Skipping is safe here in a way blocking
 * is not: the parcel stays queued and un-drained, so whichever dispatcher holds the lock carries
 * it and the loser simply retries on its next cycle. Waiting would both stall a poll cycle behind
 * an unrelated carry and, worse, hand the loser a draft the winner had already drained.
 */
export async function withParcelLock<T>(
  repoRoot: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lockDir = getParcelLockDir(repoRoot, sanitizeLockKey(key))
  if (!(await acquire(lockDir, getLocksDir(repoRoot)))) return null
  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** A lock key safe as a single path segment, so an agent name can never escape the locks dir. */
export function sanitizeLockKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_')
}

async function acquire(lockDir: string, locksRoot: string): Promise<boolean> {
  await mkdir(locksRoot, { recursive: true }).catch(() => {})
  if (await tryMkdir(lockDir)) return true
  // A single retry, and only to reclaim an abandoned lock. Deliberately NOT a wait-for-the-holder
  // loop: waiting would let a second carry of the same parcel start the moment the first finished,
  // against an outbox draft the first has already drained — turning a clean yield into a confusing
  // "draft not found" failure. Yielding costs one poll cycle and nothing else.
  if (!(await takeOverIfStale(lockDir))) return false
  return tryMkdir(lockDir)
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

/**
 * Reclaim a lock whose holder died. Without this a crash mid-carry wedges that parcel forever —
 * strictly worse than the race the lock prevents, since the race is recoverable and a wedge is not.
 * The age bound is deliberately far longer than any real carry, so a slow rsync is never stolen.
 */
async function takeOverIfStale(lockDir: string): Promise<boolean> {
  try {
    const age = Date.now() - (await stat(lockDir)).mtimeMs
    if (age < STALE_AFTER_MS) return false
    await rm(lockDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** A lock older than this is treated as abandoned by a crashed process. */
const STALE_AFTER_MS = 15 * 60 * 1000
