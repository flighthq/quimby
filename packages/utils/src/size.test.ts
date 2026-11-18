import { describe, expect, it } from 'vitest'

import { formatByteSizeKb, parseByteSizeKb } from './size'

describe('formatByteSizeKb', () => {
  it('picks the coarsest unit with one decimal', () => {
    expect(formatByteSizeKb(512)).toBe('512K')
    expect(formatByteSizeKb(3.5 * 1024)).toBe('3.5M')
    expect(formatByteSizeKb(631.8 * 1024 * 1024)).toBe('631.8G')
    expect(formatByteSizeKb(1.4 * 1024 ** 3)).toBe('1.4T')
  })

  it('renders an unmeasured size as ? rather than 0, since 0 would be a claim', () => {
    expect(formatByteSizeKb(undefined)).toBe('?')
  })
})

describe('parseByteSizeKb', () => {
  it('parses unit suffixes, with or without B', () => {
    expect(parseByteSizeKb('100G')).toBe(100 * 1024 * 1024)
    expect(parseByteSizeKb('500mb')).toBe(500 * 1024)
    expect(parseByteSizeKb('1.5T')).toBe(1.5 * 1024 ** 3)
    expect(parseByteSizeKb('64K')).toBe(64)
  })

  it('reads a bare number as GB', () => {
    expect(parseByteSizeKb(50)).toBe(50 * 1024 * 1024)
    expect(parseByteSizeKb('50')).toBe(50 * 1024 * 1024)
  })

  it('returns null for garbage instead of guessing', () => {
    expect(parseByteSizeKb('lots')).toBeNull()
    expect(parseByteSizeKb('10%')).toBeNull()
    expect(parseByteSizeKb(undefined)).toBeNull()
  })
})
