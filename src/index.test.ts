import { describe, expect, it } from 'vitest'

import * as indexExports from './index'

describe('index', () => {
  it('exports isSSH function', () => {
    expect(typeof indexExports.isSSH).toBe('function')
  })

  it('isSSH returns false for undefined', () => {
    expect(indexExports.isSSH(undefined)).toBe(false)
  })

  it('isSSH returns true for SSH location', () => {
    expect(indexExports.isSSH({ type: 'ssh', host: 'user@box' })).toBe(true)
  })

  it('isSSH returns false for local location', () => {
    expect(indexExports.isSSH({ type: 'local' })).toBe(false)
  })
})
