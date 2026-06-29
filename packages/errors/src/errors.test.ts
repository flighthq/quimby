import { describe, expect, it } from 'vitest'

import { GitError, PackError, QuimbyError, WorkerError } from './errors'

describe('QuimbyError', () => {
  it('sets message correctly', () => {
    const err = new QuimbyError('something went wrong')
    expect(err.message).toBe('something went wrong')
  })

  it('sets name to QuimbyError', () => {
    const err = new QuimbyError('test')
    expect(err.name).toBe('QuimbyError')
  })

  it('is an instance of Error', () => {
    const err = new QuimbyError('test')
    expect(err instanceof Error).toBe(true)
  })

  it('sets optional code', () => {
    const err = new QuimbyError('test', 'MY_CODE')
    expect(err.code).toBe('MY_CODE')
  })

  it('code is undefined when not provided', () => {
    const err = new QuimbyError('test')
    expect(err.code).toBeUndefined()
  })
})

describe('GitError', () => {
  it('is instanceof QuimbyError and Error', () => {
    const err = new GitError('git failed')
    expect(err instanceof QuimbyError).toBe(true)
    expect(err instanceof Error).toBe(true)
  })

  it('sets name to GitError', () => {
    const err = new GitError('git failed')
    expect(err.name).toBe('GitError')
  })

  it('sets message correctly', () => {
    const err = new GitError('git clone failed')
    expect(err.message).toBe('git clone failed')
  })

  it('sets code to GIT_ERROR', () => {
    const err = new GitError('test')
    expect(err.code).toBe('GIT_ERROR')
  })

  it('sets optional stderr', () => {
    const err = new GitError('git failed', 'fatal: not a git repo')
    expect(err.stderr).toBe('fatal: not a git repo')
  })

  it('stderr is undefined when not provided', () => {
    const err = new GitError('git failed')
    expect(err.stderr).toBeUndefined()
  })
})

describe('WorkerError', () => {
  it('is instanceof QuimbyError and Error', () => {
    const err = new WorkerError('worker not found')
    expect(err instanceof QuimbyError).toBe(true)
    expect(err instanceof Error).toBe(true)
  })

  it('sets name to WorkerError', () => {
    const err = new WorkerError('worker not found')
    expect(err.name).toBe('WorkerError')
  })

  it('sets message correctly', () => {
    const err = new WorkerError('Worker "alice" not found')
    expect(err.message).toBe('Worker "alice" not found')
  })

  it('sets code to WORKER_ERROR', () => {
    const err = new WorkerError('test')
    expect(err.code).toBe('WORKER_ERROR')
  })

  it('sets optional workerName', () => {
    const err = new WorkerError('not found', 'alice')
    expect(err.workerName).toBe('alice')
  })

  it('workerName is undefined when not provided', () => {
    const err = new WorkerError('not found')
    expect(err.workerName).toBeUndefined()
  })
})

describe('PackError', () => {
  it('is instanceof QuimbyError and Error', () => {
    const err = new PackError('pack not found')
    expect(err instanceof QuimbyError).toBe(true)
    expect(err instanceof Error).toBe(true)
  })

  it('sets name to PackError', () => {
    const err = new PackError('pack not found')
    expect(err.name).toBe('PackError')
  })

  it('sets message correctly', () => {
    const err = new PackError('Pack "alice-1" not found')
    expect(err.message).toBe('Pack "alice-1" not found')
  })

  it('sets code to PACK_ERROR', () => {
    const err = new PackError('test')
    expect(err.code).toBe('PACK_ERROR')
  })

  it('sets optional packName', () => {
    const err = new PackError('not found', 'alice-1')
    expect(err.packName).toBe('alice-1')
  })

  it('packName is undefined when not provided', () => {
    const err = new PackError('not found')
    expect(err.packName).toBeUndefined()
  })
})
