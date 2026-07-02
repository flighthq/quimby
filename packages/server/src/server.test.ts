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

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-server-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
  await execa('git', ['init'], { cwd: dir })
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: dir })
  await writeFile(join(dir, 'README.md'), '# test')
  await execa('git', ['add', '-A'], { cwd: dir })
  await execa('git', ['commit', '-m', 'initial'], { cwd: dir })
  await ensureWorkspace(dir)
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

  it('serves GET /api/status with live counts', async () => {
    await startOnEphemeral()
    const { status, json } = await api('GET', '/api/status')
    expect(status).toBe(200)
    expect(json).toMatchObject({ port: handle!.port, agents: 2, subscriptions: 0 })
  })

  it('serves GET /api/agents and 404s an unknown agent', async () => {
    await startOnEphemeral()
    expect((await api('GET', '/api/agents')).json).toHaveProperty('backend')
    expect((await api('GET', '/api/agents/ghost')).status).toBe(404)
  })

  it('adds and removes a subscription through the API, persisting to state', async () => {
    await startOnEphemeral()

    const added = await api('POST', '/api/subscriptions', {
      subscriber: 'reviewer',
      target: 'backend',
    })
    expect(added).toEqual({ status: 200, json: { ok: true } })
    expect((await loadState(dir)).subscriptions?.reviewer).toEqual(['backend'])
    expect((await api('GET', '/api/subscriptions')).json).toEqual({ reviewer: ['backend'] })

    const removed = await api('DELETE', '/api/subscriptions/reviewer/backend')
    expect(removed.status).toBe(200)
    expect((await loadState(dir)).subscriptions?.reviewer).toBeUndefined()
  })

  it('rejects a subscription POST missing fields with 400', async () => {
    await startOnEphemeral()
    expect((await api('POST', '/api/subscriptions', { subscriber: 'reviewer' })).status).toBe(400)
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
})
