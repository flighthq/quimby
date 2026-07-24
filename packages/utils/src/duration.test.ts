import { describe, expect, it } from 'vitest'

import { formatDuration, parseDuration } from './duration'

describe('formatDuration', () => {
  it('shows seconds under a minute', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(0)).toBe('0s')
  })

  it('shows whole minutes under an hour', () => {
    expect(formatDuration(14 * 60_000)).toBe('14m')
  })

  it('shows the two coarsest units past an hour', () => {
    expect(formatDuration(3 * 3_600_000 + 12 * 60_000)).toBe('3h12m')
    expect(formatDuration(2 * 3_600_000)).toBe('2h')
    expect(formatDuration(2 * 86_400_000 + 4 * 3_600_000)).toBe('2d4h')
    expect(formatDuration(2 * 86_400_000)).toBe('2d')
  })

  it('floors a negative span at zero', () => {
    expect(formatDuration(-5000)).toBe('0s')
  })
})

describe('parseDuration', () => {
  it('parses each unit suffix', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('45m')).toBe(2_700_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('1d')).toBe(86_400_000)
  })

  it('reads a bare number as minutes', () => {
    expect(parseDuration('90')).toBe(5_400_000)
    expect(parseDuration(90)).toBe(5_400_000)
  })

  it('tolerates surrounding space and a capital unit', () => {
    expect(parseDuration(' 2H ')).toBe(7_200_000)
  })

  it('returns null for unparseable or missing input', () => {
    expect(parseDuration('soon')).toBeNull()
    expect(parseDuration('2 hours')).toBeNull()
    expect(parseDuration('')).toBeNull()
    expect(parseDuration(undefined)).toBeNull()
    expect(parseDuration(-5)).toBeNull()
  })
})
