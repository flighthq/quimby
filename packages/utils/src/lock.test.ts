import { mkdir, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { withDirLock } from './lock'

let dir: string

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-lock-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('withDirLock', () => {
  it('runs the body and releases the lock afterwards', async () => {
    const lockDir = join(dir, 'a.lock')

    expect(await withDirLock(lockDir, async () => 'done')).toBe('done')

    await expect(stat(lockDir)).rejects.toThrow()
  })

  it('releases the lock even when the body throws', async () => {
    const lockDir = join(dir, 'a.lock')

    await expect(
      withDirLock(lockDir, async () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')

    await expect(stat(lockDir)).rejects.toThrow()
  })

  it('serializes two holders rather than letting both run at once', async () => {
    const lockDir = join(dir, 'a.lock')
    let concurrent = 0
    let peak = 0
    const body = async (): Promise<void> => {
      concurrent++
      peak = Math.max(peak, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 30))
      concurrent--
    }

    await Promise.all([
      withDirLock(lockDir, body, { waitMs: 5000 }),
      withDirLock(lockDir, body, { waitMs: 5000 }),
    ])

    expect(peak).toBe(1)
  })

  it('yields immediately by default rather than waiting for the holder', async () => {
    const lockDir = join(dir, 'a.lock')
    await mkdir(lockDir)

    expect(await withDirLock(lockDir, async () => 'ran')).toBeNull()
  })

  it('gives up once the wait elapses, reporting contention rather than hanging', async () => {
    const lockDir = join(dir, 'a.lock')
    await mkdir(lockDir)

    expect(await withDirLock(lockDir, async () => 'ran', { waitMs: 150 })).toBeNull()
  })

  // A crash mid-operation would otherwise wedge that key forever — strictly worse than the race
  // the lock prevents, since the race is recoverable and a wedge is not.
  it('reclaims a lock whose holder died', async () => {
    const lockDir = join(dir, 'a.lock')
    await mkdir(lockDir)
    const longAgo = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(lockDir, longAgo, longAgo)

    expect(await withDirLock(lockDir, async () => 'ran', { staleAfterMs: 1000 })).toBe('ran')
  })

  it('does not steal a lock from a live holder', async () => {
    const lockDir = join(dir, 'a.lock')
    await mkdir(lockDir)

    expect(await withDirLock(lockDir, async () => 'ran', { staleAfterMs: 60_000 })).toBeNull()
  })
})
