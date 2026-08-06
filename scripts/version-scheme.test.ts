import { describe, expect, it } from 'vitest'

import { applyBump, detectBumpLevel, isBreakingCommit, isFeatureCommit } from './version-scheme'

describe('applyBump', () => {
  // Pre-1.0 is the ZeroVer lane: every level shifts down one digit, and the major stays 0.
  it('bumps the minor for a breaking change while the base major is 0', () => {
    expect(applyBump('0.2.0', 'breaking')).toBe('0.3.0')
  })

  it('bumps the patch for a feature or a fix while the base major is 0', () => {
    expect(applyBump('0.2.0', 'feature')).toBe('0.2.1')
    expect(applyBump('0.2.3', 'fix')).toBe('0.2.4')
  })

  // The lane is keyed on the base major, so a real 1.0.0 switches it with no code change.
  it('applies the normal lane once the base major is at least 1', () => {
    expect(applyBump('1.4.2', 'breaking')).toBe('2.0.0')
    expect(applyBump('1.4.2', 'feature')).toBe('1.5.0')
    expect(applyBump('1.4.2', 'fix')).toBe('1.4.3')
  })

  it('throws on a base that is not <major>.<minor>.<patch>', () => {
    expect(() => applyBump('0.2', 'fix')).toThrow(/base version/)
  })
})

describe('detectBumpLevel', () => {
  it('takes the highest level present, breaking outranking feature', () => {
    expect(detectBumpLevel(['fix: a', 'feat: b', 'refactor!: c'])).toBe('breaking')
  })

  it('reports a feature when the highest level is a feat', () => {
    expect(detectBumpLevel(['chore: a', 'feat(cli): b', 'docs: c'])).toBe('feature')
  })

  // An unrecognized subject must not fail the publish — a repo drifting off conventional commits
  // still needs monotonic snapshot versions.
  it('falls back to a fix for messages it does not recognize', () => {
    expect(detectBumpLevel(['tidy up the launcher', 'wip'])).toBe('fix')
    expect(detectBumpLevel([])).toBe('fix')
  })
})

describe('isBreakingCommit', () => {
  it('recognizes a bang before the colon, with or without a scope', () => {
    expect(isBreakingCommit('feat!: drop the pack verb')).toBe(true)
    expect(isBreakingCommit('refactor(handoff)!: rename the tray')).toBe(true)
  })

  it('recognizes a BREAKING CHANGE footer anywhere in the body', () => {
    expect(isBreakingCommit('feat: x\n\nBREAKING CHANGE: the seed moved')).toBe(true)
    expect(isBreakingCommit('fix: y\n\nBREAKING-CHANGE: the seed moved')).toBe(true)
  })

  it('does not treat an ordinary subject as breaking', () => {
    expect(isBreakingCommit('feat(cli): add sessions prune')).toBe(false)
    expect(isBreakingCommit('fix: a breaking change is mentioned in prose')).toBe(false)
  })
})

describe('isFeatureCommit', () => {
  it('recognizes feat with and without a scope', () => {
    expect(isFeatureCommit('feat: add disable')).toBe(true)
    expect(isFeatureCommit('feat(storage): list remote workspaces')).toBe(true)
  })

  it('rejects other conventional types and a bare subject', () => {
    expect(isFeatureCommit('fix(server): retry a held reminder')).toBe(false)
    expect(isFeatureCommit('features are nice')).toBe(false)
  })
})
