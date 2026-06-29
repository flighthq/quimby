import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getQuimbyDir } from '@quimbyhq/paths'
import { writeText } from '@quimbyhq/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getServerInfo, isServerRunning, serverDelete, serverGet, serverPost } from './client'

let dir: string

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-client-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
  await mkdir(getQuimbyDir(dir), { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function writeServerJson(port: number, pid: number) {
  return writeText(
    join(getQuimbyDir(dir), 'server.json'),
    JSON.stringify({ port, pid, startedAt: new Date().toISOString() }),
  )
}

describe('getServerInfo', () => {
  it('returns null when server.json does not exist', async () => {
    const info = await getServerInfo(dir)
    expect(info).toBeNull()
  })

  it('returns null when server.json exists but process is not running', async () => {
    // PID 99999999 is very unlikely to exist
    await writeServerJson(7749, 99999999)
    const info = await getServerInfo(dir)
    expect(info).toBeNull()
  })

  it('returns ServerInfo when process is running', async () => {
    // Use the current process PID to simulate a running server
    await writeServerJson(7749, process.pid)
    const info = await getServerInfo(dir)
    expect(info).not.toBeNull()
    expect(info?.port).toBe(7749)
    expect(info?.pid).toBe(process.pid)
  })
})

describe('isServerRunning', () => {
  it('returns false when server.json is absent', async () => {
    expect(await isServerRunning(dir)).toBe(false)
  })

  it('returns true when server is running (using current PID)', async () => {
    await writeServerJson(7749, process.pid)
    // Mock fetch to respond OK
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }))
    expect(await isServerRunning(dir)).toBe(true)
  })
})

describe('serverGet', () => {
  it('returns null when server is not running', async () => {
    const result = await serverGet(dir, '/api/status')
    expect(result).toBeNull()
  })

  it('returns parsed JSON on 200 when server is running', async () => {
    await writeServerJson(7749, process.pid)
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    const result = await serverGet(dir, '/api/status')
    expect(result).toEqual({ ok: true })
  })

  it('returns null on non-2xx response', async () => {
    await writeServerJson(7749, process.pid)
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
    const result = await serverGet(dir, '/api/missing')
    expect(result).toBeNull()
  })
})

describe('serverPost', () => {
  it('returns false when server is not running', async () => {
    expect(await serverPost(dir, '/api/subscriptions', {})).toBe(false)
  })

  it('returns true on 2xx response', async () => {
    await writeServerJson(7749, process.pid)
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 201 }))
    expect(await serverPost(dir, '/api/subscriptions', { subscriber: 'a', target: 'b' })).toBe(true)
  })

  it('returns false on non-2xx response', async () => {
    await writeServerJson(7749, process.pid)
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('Bad Request', { status: 400 }))
    expect(await serverPost(dir, '/api/subscriptions', {})).toBe(false)
  })
})

describe('serverDelete', () => {
  it('returns false when server is not running', async () => {
    expect(await serverDelete(dir, '/api/subscriptions/a/b')).toBe(false)
  })

  it('returns true on 2xx response', async () => {
    await writeServerJson(7749, process.pid)
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 200 }))
    expect(await serverDelete(dir, '/api/subscriptions/a/b')).toBe(true)
  })

  it('returns false on non-2xx response', async () => {
    await writeServerJson(7749, process.pid)
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
    expect(await serverDelete(dir, '/api/subscriptions/a/b')).toBe(false)
  })
})
