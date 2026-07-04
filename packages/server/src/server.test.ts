import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exists } from '@quimbyhq/utils'
import { ensureWorkspace, loadState, saveState } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type QuimbyServerHandle, startServer } from './server'

let dir: string
let handle: QuimbyServerHandle | null

async function startOnEphemeral(): Promise<QuimbyServerHandle> {
  // port 0 → OS-assigned; poll rarely so the interval never fires mid-test
  handle = await startServer({
    repoRoot: dir,
    port: 0,
    pollInterval: 1_000_000,
    autoDispatch: false,
  })
  return handle
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${handle!.port}${path}`, {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  })
  return { status: res.status, json: await res.json() }
}

async function makeWorkspace(): Promise<string> {
  const d = join(tmpdir(), `quimby-server-${crypto.randomUUID()}`)
  await mkdir(d, { recursive: true })
  await execa('git', ['init'], { cwd: d })
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: d })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: d })
  await writeFile(join(d, 'README.md'), '# test')
  await execa('git', ['add', '-A'], { cwd: d })
  await execa('git', ['commit', '-m', 'initial'], { cwd: d })
  await ensureWorkspace(d)
  return d
}

beforeEach(async () => {
  dir = await makeWorkspace()
  const state = await loadState(dir)
  state.agents.backend = { id: 'b1', name: 'backend', location: { type: 'local' } } as never
  state.agents.reviewer = { id: 'r1', name: 'reviewer', location: { type: 'local' } } as never
  await saveState(dir, state)
  handle = null
})

afterEach(async () => {
  if (handle) await handle.stop()
  await rm(dir, { recursive: true, force: true })
})

describe('startServer', () => {
  it('binds an ephemeral port and reports it in the handle + pidfile', async () => {
    const h = await startOnEphemeral()
    expect(h.port).toBeGreaterThan(0)
    expect(await exists(join(dir, '.quimby', 'server.json'))).toBe(true)
  })

  it('serves GET /api/status with the live agent count', async () => {
    await startOnEphemeral()
    const { status, json } = await api('GET', '/api/status')
    expect(status).toBe(200)
    expect(json).toMatchObject({ port: handle!.port, agents: 2 })
  })

  it('serves GET /api/agents and 404s an unknown agent', async () => {
    await startOnEphemeral()
    expect((await api('GET', '/api/agents')).json).toHaveProperty('backend')
    expect((await api('GET', '/api/agents/ghost')).status).toBe(404)
  })

  it('404s an unknown route', async () => {
    await startOnEphemeral()
    expect((await api('GET', '/nope')).status).toBe(404)
  })

  it('stop() is idempotent and removes the pidfile', async () => {
    const h = await startOnEphemeral()
    await h.stop()
    await h.stop()
    expect(await exists(join(dir, '.quimby', 'server.json'))).toBe(false)
    handle = null
  })

  it('two servers with no explicit port bind distinct, reachable ports', async () => {
    // Mirrors `quimby serve` in two workspaces: neither pins a port, so the second must fall
    // back off the shared 7749 default instead of clashing. Whether or not 7749 is free here,
    // the guarantee is that the two land on different, individually reachable ports.
    handle = await startServer({ repoRoot: dir, pollInterval: 1_000_000, autoDispatch: false })
    const dir2 = await makeWorkspace()
    const other = await startServer({
      repoRoot: dir2,
      pollInterval: 1_000_000,
      autoDispatch: false,
    })
    try {
      expect(handle.port).toBeGreaterThan(0)
      expect(other.port).toBeGreaterThan(0)
      expect(other.port).not.toBe(handle.port)
      expect((await fetch(`http://127.0.0.1:${handle.port}/api/status`)).status).toBe(200)
      expect((await fetch(`http://127.0.0.1:${other.port}/api/status`)).status).toBe(200)
    } finally {
      await other.stop()
      await rm(dir2, { recursive: true, force: true })
    }
  })

  it('errors when an explicitly requested port is already in use', async () => {
    handle = await startOnEphemeral()
    await expect(
      startServer({
        repoRoot: dir,
        port: handle.port,
        pollInterval: 1_000_000,
        autoDispatch: false,
      }),
    ).rejects.toThrow(/already in use/)
  })

  it('walks upward from a busy default port instead of landing on a random one', async () => {
    const { createServer } = await import('node:net')
    const blocker = createServer()
    const heldDefault = await new Promise<boolean>((resolve) => {
      blocker.once('error', () => resolve(false))
      blocker.once('listening', () => resolve(true))
      blocker.listen(7749, '127.0.0.1')
    })
    try {
      handle = await startServer({ repoRoot: dir, pollInterval: 1_000_000, autoDispatch: false })
      // With 7749 busy it should climb to a nearby port in the scan window, never a far-off
      // OS-assigned one. (If the env already held 7749, the same near-the-default guarantee holds.)
      void heldDefault
      expect(handle.port).toBeGreaterThanOrEqual(7750)
      expect(handle.port).toBeLessThanOrEqual(7749 + 16)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})
