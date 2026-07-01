import { describe, expect, it } from 'vitest'

import { getSSHTransport, sq, toRsyncExcludeList } from './sshTransport'

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

describe('toRsyncExcludeList', () => {
  it('returns an empty string for empty input', () => {
    expect(toRsyncExcludeList('')).toBe('')
  })

  it('anchors a single ignored file to the transfer root', () => {
    expect(toRsyncExcludeList('build/app\0')).toBe('/build/app')
  })

  it('preserves a directory entry trailing slash', () => {
    expect(toRsyncExcludeList('build/\0')).toBe('/build/')
  })

  it('anchors each path and rejoins them NUL-separated', () => {
    expect(toRsyncExcludeList('target/\0bin/tool\0a.o\0')).toBe('/target/\0/bin/tool\0/a.o')
  })

  it('ignores empty entries from a trailing or doubled NUL', () => {
    expect(toRsyncExcludeList('x.o\0\0y.o\0')).toBe('/x.o\0/y.o')
  })

  it('keeps paths with spaces intact', () => {
    expect(toRsyncExcludeList('build output/big.bin\0')).toBe('/build output/big.bin')
  })
})
