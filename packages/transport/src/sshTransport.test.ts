import { describe, expect, it } from 'vitest'

import { getSSHTransport, sq } from './sshTransport'

describe('getSSHTransport', () => {
  it('returns an SSHTransport for a given SSH location', () => {
    const transport = getSSHTransport({ type: 'ssh', host: 'user@box' })
    expect(transport).toBeDefined()
    expect(typeof transport.readFile).toBe('function')
    expect(typeof transport.exec).toBe('function')
  })
})

describe('sq', () => {
  it('wraps a simple string in single quotes', () => {
    expect(sq('hello')).toBe("'hello'")
  })

  it('escapes embedded single quotes', () => {
    expect(sq("it's here")).toBe("'it'\"'\"'s here'")
  })

  it('handles empty string', () => {
    expect(sq('')).toBe("''")
  })

  it('handles strings with spaces', () => {
    expect(sq('hello world')).toBe("'hello world'")
  })
})
