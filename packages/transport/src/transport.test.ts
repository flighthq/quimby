import { describe, expect, it } from 'vitest'

import { getTransport } from './transport'

describe('getTransport', () => {
  it('returns LocalTransport for local location type', () => {
    const transport = getTransport({ type: 'local' })
    expect(transport).toBeDefined()
  })

  it('returns LocalTransport when location is undefined', () => {
    const transport = getTransport(undefined)
    expect(transport).toBeDefined()
    expect(typeof transport.readFile).toBe('function')
    expect(typeof transport.writeFile).toBe('function')
    expect(typeof transport.fileExists).toBe('function')
    expect(typeof transport.ensureDir).toBe('function')
  })

  it('returns SSHTransport when location is SSH', () => {
    const transport = getTransport({ type: 'ssh', host: 'user@box' })
    expect(transport).toBeDefined()
    expect(typeof transport.readFile).toBe('function')
    expect(typeof transport.writeFile).toBe('function')
  })
})
