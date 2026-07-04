import { describe, expect, it } from 'vitest'

import { isResolvedSSHLocation } from './SSHLocation'

describe('isResolvedSSHLocation', () => {
  it('returns true when host is a bound, non-empty string', () => {
    expect(isResolvedSSHLocation({ type: 'ssh', host: 'user@host' })).toBe(true)
  })

  it('returns true even when an alias is also present', () => {
    expect(isResolvedSSHLocation({ type: 'ssh', host: 'user@host', alias: 'remote' })).toBe(true)
  })

  it('returns false when only an unresolved alias is carried', () => {
    expect(isResolvedSSHLocation({ type: 'ssh', alias: 'remote' })).toBe(false)
  })

  it('returns false when host is absent', () => {
    expect(isResolvedSSHLocation({ type: 'ssh' })).toBe(false)
  })

  it('returns false when host is the empty string', () => {
    expect(isResolvedSSHLocation({ type: 'ssh', host: '' })).toBe(false)
  })
})
