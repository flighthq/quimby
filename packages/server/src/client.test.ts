import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getQuimbyDir } from '@quimbyhq/paths'
import { writeText } from '@quimbyhq/utils'
import { exists } from '@quimbyhq/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getServerInfo, isServerRunning, serverGet, stopServer } from './client'

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

describe('stopServer', () => {
  it('returns null and clears a stale pidfile when no live server is found', async () => {
    // A dead pid: getServerInfo reports "not running", but the pidfile must still be swept.
    await writeServerJson(7749, 99999999)
    expect(await stopServer(dir)).toBeNull()
    expect(await exists(join(getQuimbyDir(dir), 'server.json'))).toBe(false)
  })

  it('returns null when there is nothing to stop', async () => {
    expect(await stopServer(dir)).toBeNull()
  })

  it('signals the running pid, removes the pidfile, and returns its info', async () => {
    // Mock kill so the SIGTERM (and getServerInfo's liveness probe) never touch the test runner.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    await writeServerJson(7749, process.pid)
    const stopped = await stopServer(dir)
    expect(stopped).toMatchObject({ pid: process.pid, port: 7749 })
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM')
    expect(await exists(join(getQuimbyDir(dir), 'server.json'))).toBe(false)
  })
})
