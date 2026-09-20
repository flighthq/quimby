import { getParcelLockDir } from '@quimbyhq/paths'
import { withDirLock } from '@quimbyhq/utils'

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
  return withDirLock(getParcelLockDir(repoRoot, sanitizeLockKey(key)), fn)
}

/** A lock key safe as a single path segment, so an agent name can never escape the locks dir. */
export function sanitizeLockKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_')
}
