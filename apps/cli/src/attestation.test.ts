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
  it('renders a passing attestation with command, mark, commit, summary, and self-reported qualifier', () => {
    const out = formatAttestation(pass)
    expect(out).toContain('npm run ci')
    expect(out).toContain('passed')
    expect(out).toContain('a1b2c3d')
    expect(out).toContain('646 tests green')
    expect(out).toContain('(self-reported)')
  })

  it('renders failed for a failing result', () => {
    expect(formatAttestation({ command: 'x', result: 'fail' })).toContain('failed')
  })

  it('reads as "not run" when there is no attestation', () => {
    expect(formatAttestation(null)).toBe('not run')
  })

  it('flags stale when the live hash differs from the attested atCommit', () => {
    expect(formatAttestation(pass, 'deadbeef')).toContain('STALE')
  })

  it('is not stale when the live hash matches atCommit', () => {
    expect(formatAttestation(pass, 'a1b2c3d')).not.toContain('STALE')
  })

  it('is prefix-tolerant: a short attested hash matches a full live one', () => {
    expect(formatAttestation(pass, 'a1b2c3d9f8e7')).not.toContain('STALE')
  })

  it('is not stale when no live hash is available', () => {
    expect(formatAttestation(pass, null)).not.toContain('STALE')
  })
})
