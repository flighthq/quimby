import type { AgentLocation } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import { buildSSHLocation, mergeSSHLocation, parseSSHHostSpec } from './location'

describe('buildSSHLocation', () => {
  it('builds a host-only location', () => {
    expect(buildSSHLocation('user@box')).toEqual({ type: 'ssh', host: 'user@box' })
  })

  it('splits a host:/base spec and keeps the base', () => {
    expect(buildSSHLocation('user@box:/srv/work')).toEqual({
      type: 'ssh',
      host: 'user@box',
      base: '/srv/work',
    })
  })

  it('includes the port only when given', () => {
    expect(buildSSHLocation('box', 2222)).toEqual({ type: 'ssh', host: 'box', port: 2222 })
    expect(buildSSHLocation('box')).not.toHaveProperty('port')
  })
})

describe('mergeSSHLocation', () => {
  const current: AgentLocation = { type: 'ssh', host: 'old@box', base: '/srv/old', port: 22 }

  it('returns null when neither the update nor the current location has a host', () => {
    expect(mergeSSHLocation(undefined, {})).toBeNull()
    expect(mergeSSHLocation({ type: 'local' }, { port: 2222 })).toBeNull()
  })

  it('overrides host and base from a new host spec', () => {
    expect(mergeSSHLocation(current, { hostSpec: 'new@host:/srv/new' })).toEqual({
      type: 'ssh',
      host: 'new@host',
      base: '/srv/new',
      port: 22,
    })
  })

  it('keeps the existing base when only the port changes (the old inline logic dropped it)', () => {
    expect(mergeSSHLocation(current, { port: 2222 })).toEqual({
      type: 'ssh',
      host: 'old@box',
      base: '/srv/old',
      port: 2222,
    })
  })

  it('drops the base when a new host spec has no :/base', () => {
    expect(mergeSSHLocation(current, { hostSpec: 'new@host' })).toEqual({
      type: 'ssh',
      host: 'new@host',
      port: 22,
    })
  })
})

describe('parseSSHHostSpec', () => {
  it('returns the whole string as host when there is no :/', () => {
    expect(parseSSHHostSpec('user@box')).toEqual({ host: 'user@box' })
  })

  it('splits on the first :/ into host and base', () => {
    expect(parseSSHHostSpec('user@box:/a/b')).toEqual({ host: 'user@box', base: '/a/b' })
  })
})
