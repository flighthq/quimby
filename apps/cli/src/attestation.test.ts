import type { AgentAttestation } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import { formatAttestation } from './attestation'

const pass: AgentAttestation = {
  command: 'npm run ci',
  result: 'pass',
  summary: '646 tests green',
  atCommit: 'a1b2c3d',
}

describe('formatAttestation', () => {
  it('renders a passing attestation with command, mark, commit, and summary', () => {
    const out = formatAttestation(pass)
    expect(out).toContain('npm run ci')
    expect(out).toContain('PASSED')
    expect(out).toContain('a1b2c3d')
    expect(out).toContain('646 tests green')
  })

  it('renders FAILED for a failing result', () => {
    expect(formatAttestation({ command: 'x', result: 'fail' })).toContain('FAILED')
  })

  it('reads as unverified when there is no attestation', () => {
    expect(formatAttestation(null)).toBe('unverified (no attestation)')
  })

  it('flags stale when the live hash differs from the attested atCommit', () => {
    expect(formatAttestation(pass, 'deadbeef')).toContain('STALE')
  })

  it('is not stale when the live hash matches atCommit', () => {
    expect(formatAttestation(pass, 'a1b2c3d')).not.toContain('STALE')
  })
})
