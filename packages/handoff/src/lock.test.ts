import { mkdir, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { getParcelLockDir } from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sanitizeLockKey, withParcelLock } from './lock'

let dir: string

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-lock-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sanitizeLockKey', () => {
  it('reduces a key to one safe path segment, so a name cannot escape the locks dir', () => {
    expect(sanitizeLockKey('manager-critic')).toBe('manager-critic')
    expect(sanitizeLockKey('../../etc/passwd')).toBe('______etc_passwd')
    expect(sanitizeLockKey('a/b')).toBe('a_b')
  })
})

describe('withParcelLock', () => {
  it('runs the body and releases the lock afterwards', async () => {
    const result = await withParcelLock(dir, 'a-b', async () => 'carried')
    expect(result).toBe('carried')
    expect(await exists(getParcelLockDir(dir, 'a-b'))).toBe(false)
  })

  it('releases the lock even when the body throws, so a failure cannot wedge the parcel', async () => {
    await expect(
      withParcelLock(dir, 'a-b', async () => {
        throw new Error('carry blew up')
      }),
    ).rejects.toThrow('carry blew up')
    expect(await exists(getParcelLockDir(dir, 'a-b'))).toBe(false)
  })

  it('admits only one holder at a time — the concurrency the staging race needs excluded', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const carry = () =>
      withParcelLock(dir, 'a-b', async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight)
        await new Promise((r) => setTimeout(r, 120))
        inFlight--
        return 'ok'
      })

    const results = await Promise.all([carry(), carry(), carry()])

    expect(maxInFlight).toBe(1)
    // The losers yield their turn rather than waiting out the holder.
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
    expect(results.filter((r) => r === null)).toHaveLength(2)
  })

  it('does not serialize different parcels', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const carry = (key: string) =>
      withParcelLock(dir, key, async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight)
        await new Promise((r) => setTimeout(r, 60))
        inFlight--
        return 'ok'
      })

    await Promise.all([carry('a-b'), carry('a-c'), carry('d-e')])

    expect(maxInFlight).toBe(3)
  })

  it('reclaims a lock abandoned by a crashed holder, rather than wedging the parcel forever', async () => {
    // A lock left behind with no live owner — the crash case. Backdate it past the stale bound.
    const lockDir = getParcelLockDir(dir, 'a-b')
    await mkdir(lockDir, { recursive: true })
    const old = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(lockDir, old, old)
    expect((await stat(lockDir)).mtimeMs).toBeLessThan(Date.now() - 30 * 60 * 1000)

    expect(await withParcelLock(dir, 'a-b', async () => 'carried')).toBe('carried')
  })
})
