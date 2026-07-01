import { describe, expect, it } from 'vitest'

import { isSSH } from './AgentLocation'

describe('isSSH', () => {
  it('returns true for an SSH location', () => {
    expect(isSSH({ type: 'ssh', host: 'user@host' })).toBe(true)
  })

  it('returns false for a local location', () => {
    expect(isSSH({ type: 'local' })).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isSSH(undefined)).toBe(false)
  })
})
