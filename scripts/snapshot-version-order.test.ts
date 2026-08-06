import { describe, expect, it } from 'vitest'

import { isSnapshotVersionSuperseded } from './snapshot-version-order'

describe('isSnapshotVersionSuperseded', () => {
  it('supersedes an older build count on the same base', () => {
    expect(isSnapshotVersionSuperseded('0.3.0-next.4.abc1234', '0.3.0-next.9.def5678')).toBe(true)
  })

  it('does not supersede a newer build count on the same base', () => {
    expect(isSnapshotVersionSuperseded('0.3.0-next.9.def5678', '0.3.0-next.4.abc1234')).toBe(false)
  })

  it('does not supersede an equal version, so a retry can still publish', () => {
    expect(isSnapshotVersionSuperseded('0.3.0-next.4.abc1234', '0.3.0-next.4.abc1234')).toBe(false)
  })

  it('compares the base version before the build count', () => {
    expect(isSnapshotVersionSuperseded('0.3.0-next.90.abc1234', '0.4.0-next.1.def5678')).toBe(true)
    expect(isSnapshotVersionSuperseded('0.4.0-next.1.def5678', '0.3.0-next.90.abc1234')).toBe(false)
  })

  // Per semver, a stable release outranks any prerelease of the same base — so a snapshot must not
  // drag `next` back off a release that already landed there.
  it('treats a stable release as superseding a prerelease of the same base', () => {
    expect(isSnapshotVersionSuperseded('0.3.0-next.4.abc1234', '0.3.0')).toBe(true)
    expect(isSnapshotVersionSuperseded('0.3.0', '0.3.0-next.4.abc1234')).toBe(false)
  })

  // The safe direction: an unparseable version publishes (the pre-guard behavior) rather than being
  // silently dropped while the tag is left stale.
  it('treats anything it cannot parse as not superseded', () => {
    expect(isSnapshotVersionSuperseded('0.3.0-next.4.abc1234', 'garbage')).toBe(false)
    expect(isSnapshotVersionSuperseded('not-a-version', '0.9.9')).toBe(false)
  })
})
