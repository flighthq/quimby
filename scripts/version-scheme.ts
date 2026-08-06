// The pure version arithmetic behind the snapshot channel. Split from snapshot-version.ts (which
// shells out to git) so the lane rules are unit-testable without a repository.

export type BumpLevel = 'breaking' | 'feature' | 'fix'

/**
 * Apply a conventional-commits bump to `base`, choosing which digit moves by the current lane.
 * Pre-1.0 (base major 0) is the ZeroVer lane: everything shifts down one — a breaking change bumps
 * the minor, a feature or fix bumps the patch, and the major stays 0. Once a real 1.0.0 lands the
 * base major is >= 1 and the normal lane applies (breaking → major, feature → minor, fix → patch).
 * The lane is keyed on the base major, so the switch is automatic with no code change.
 */
export function applyBump(base: string, level: BumpLevel): string {
  const [major, minor, patch] = base.split('.').map((n) => Number.parseInt(n, 10))
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`[version-scheme] base version is not <major>.<minor>.<patch>: ${base}`)
  }
  if (major === 0) {
    return level === 'breaking' ? `0.${minor + 1}.0` : `0.${minor}.${patch + 1}`
  }
  if (level === 'breaking') return `${major + 1}.0.0`
  if (level === 'feature') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/**
 * The highest conventional-commits level among `messages` (breaking outranks feature outranks fix).
 * An unrecognized subject reads as a fix, so a repo that drifts off conventional commits still
 * produces monotonic snapshot versions rather than failing the publish.
 */
export function detectBumpLevel(messages: readonly string[]): BumpLevel {
  let level: BumpLevel = 'fix'
  for (const message of messages) {
    if (isBreakingCommit(message)) return 'breaking'
    if (isFeatureCommit(message)) level = 'feature'
  }
  return level
}

/**
 * A `!` before the colon in the subject (`type!:` / `type(scope)!:`) marks a breaking change, as
 * does a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer line anywhere in the body.
 */
export function isBreakingCommit(message: string): boolean {
  const subject = message.split('\n', 1)[0] ?? ''
  return /^[a-z]+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/m.test(message)
}

/** A `feat:` / `feat(scope):` subject. A breaking `feat!:` is caught first by isBreakingCommit. */
export function isFeatureCommit(message: string): boolean {
  return /^feat(\([^)]*\))?:/.test(message.split('\n', 1)[0] ?? '')
}
