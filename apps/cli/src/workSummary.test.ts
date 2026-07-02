import { describe, expect, it } from 'vitest'

import { formatWorkSummary } from './workSummary'

describe('formatWorkSummary', () => {
  it('renders files, commits, and line deltas with the not-yet-merged tag', () => {
    expect(formatWorkSummary({ files: 3, insertions: 140, deletions: 12, commits: 2 })).toBe(
      '3 files, 2 commits, +140/-12 — not yet merged',
    )
  })

  it('singularizes one file and one commit', () => {
    expect(formatWorkSummary({ files: 1, insertions: 5, deletions: 0, commits: 1 })).toBe(
      '1 file, 1 commit, +5/-0 — not yet merged',
    )
  })

  it('omits the commit clause for uncommitted-only work', () => {
    expect(formatWorkSummary({ files: 2, insertions: 10, deletions: 3, commits: 0 })).toBe(
      '2 files, +10/-3 — not yet merged',
    )
  })

  it('reports no unmerged work when the tree matches the seed (never "synced")', () => {
    expect(formatWorkSummary({ files: 0, insertions: 0, deletions: 0, commits: 0 })).toBe(
      'no unmerged work',
    )
  })

  it('reports unavailable for a null summary', () => {
    expect(formatWorkSummary(null)).toBe('work state unavailable')
  })
})
