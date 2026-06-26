import { describe, it, expect } from 'vitest'
import { AoError, ConfigError, GitError, SandboxError } from '../../src/utils/errors.js'

describe('AoError', () => {
  it('creates an error with message', () => {
    const err = new AoError('test error')
    expect(err.message).toBe('test error')
    expect(err.name).toBe('AoError')
    expect(err).toBeInstanceOf(Error)
  })

  it('stores an optional code', () => {
    const err = new AoError('test', 'TEST_CODE')
    expect(err.code).toBe('TEST_CODE')
  })
})

describe('ConfigError', () => {
  it('sets code to CONFIG_ERROR', () => {
    const err = new ConfigError('bad config')
    expect(err.code).toBe('CONFIG_ERROR')
    expect(err.name).toBe('ConfigError')
    expect(err).toBeInstanceOf(AoError)
  })
})

describe('GitError', () => {
  it('sets code to GIT_ERROR and stores stderr', () => {
    const err = new GitError('git failed', 'fatal: not a repo')
    expect(err.code).toBe('GIT_ERROR')
    expect(err.stderr).toBe('fatal: not a repo')
    expect(err.name).toBe('GitError')
    expect(err).toBeInstanceOf(AoError)
  })
})

describe('SandboxError', () => {
  it('sets code to SANDBOX_ERROR and stores sandboxName', () => {
    const err = new SandboxError('sandbox failed', 'backend')
    expect(err.code).toBe('SANDBOX_ERROR')
    expect(err.sandboxName).toBe('backend')
    expect(err.name).toBe('SandboxError')
    expect(err).toBeInstanceOf(AoError)
  })
})
