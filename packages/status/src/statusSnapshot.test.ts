import { describe, expect, it } from 'vitest'

import { formatStatusPlaceholder, formatStatusSnapshot } from './statusSnapshot'

describe('formatStatusPlaceholder', () => {
  it('renders a placeholder body with no Updated line, distinct from a real snapshot', () => {
    expect(formatStatusPlaceholder('builder')).toBe(
      '# Status: builder\n\n_No status reported yet._\n',
    )
  })
})

describe('formatStatusSnapshot', () => {
  it('renders the status routing payload with the source name and timestamp', () => {
    expect(formatStatusSnapshot('builder', 'body', '2026-07-02T00:00:00.000Z')).toBe(
      '# Status: builder\n\nUpdated: 2026-07-02T00:00:00.000Z\n\nbody\n',
    )
  })

  // The direction of base staleness an agent cannot see for itself: `agent.sh` reports when the
  // base is ahead of IT, but nothing reported that a PEER holds work the base does not have — so
  // two agents fixed one defect twice, and a P0 was filed against code already repaired.
  it('reports what the agent holds that has not reached your base', () => {
    expect(
      formatStatusSnapshot('integration', 'landed the auth fix', '2026-07-02T00:00:00.000Z', {
        commits: 6,
        files: 14,
      }),
    ).toContain('Unmerged: 6 commit(s), 14 file(s)')
  })

  it('says so explicitly when a peer is holding nothing back', () => {
    const out = formatStatusSnapshot('builder', 'idle', '2026-07-02T00:00:00.000Z', {
      commits: 0,
      files: 0,
    })
    expect(out).toContain('Unmerged: none')
  })

  // An unreachable host or unprovisioned repo yields no position, and a snapshot asserting a zero
  // it never measured is worse than one that stays quiet. Absence means "not measured"; `0` is a
  // claim, and the two must not collapse into each other.
  it('omits the line entirely rather than claiming a zero it did not measure', () => {
    expect(formatStatusSnapshot('builder', 'body', '2026-07-02T00:00:00.000Z')).not.toContain(
      'Unmerged',
    )
  })

  // A peer's last mirror was indistinguishable from a live one, so agents kept addressing a shelved
  // agent and waiting on a reply it could never send.
  it('marks a disabled agent, so a peer knows nothing it sends will be read yet', () => {
    const out = formatStatusSnapshot(
      'builder',
      'shelved',
      '2026-07-02T00:00:00.000Z',
      undefined,
      true,
    )
    expect(out).toContain('Disabled: this agent is disabled')
    expect(out).toContain('sits unread until someone re-enables it')
  })

  it('says nothing about disabled for an ordinary agent', () => {
    expect(formatStatusSnapshot('builder', 'body', '2026-07-02T00:00:00.000Z')).not.toContain(
      'Disabled',
    )
  })

  // Disabling changes nothing about what the agent's clone holds, and "I shelved it — is it still
  // sitting on work I never merged?" is exactly what a reader needs answered.
  it('keeps the unmerged position on a disabled agent rather than replacing it', () => {
    const out = formatStatusSnapshot(
      'builder',
      'shelved',
      '2026-07-02T00:00:00.000Z',
      { commits: 3, files: 9 },
      true,
    )
    expect(out).toContain('Unmerged: 3 commit(s), 9 file(s)')
    expect(out).toContain('Disabled:')
  })

  it('keeps the position beside Updated, so it is read as a snapshot rather than as live', () => {
    const out = formatStatusSnapshot('builder', 'body', '2026-07-02T00:00:00.000Z', {
      commits: 1,
      files: 2,
    })
    expect(out.split('\n').slice(0, 4)).toEqual([
      '# Status: builder',
      '',
      'Updated: 2026-07-02T00:00:00.000Z',
      "Unmerged: 1 commit(s), 2 file(s) — in this agent's clone only, not yet on your base",
    ])
  })
})
