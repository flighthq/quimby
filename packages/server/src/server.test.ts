import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectingReporter } from '@quimbyhq/reporter'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace, loadState, saveState } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as PollerModule from './poller'
import { type QuimbyServerHandle, startServer } from './server'

// Only pollAgentStatus is stubbed, so the slow-cycle test can make a cycle overrun the interval.
// Every other test polls once per ~17 minutes, so the stub never runs for them.
const pollAgentStatus = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./poller', async (importOriginal) => ({
  ...(await importOriginal<typeof PollerModule>()),
  pollAgentStatus,
}))

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
  it('never runs two poll cycles at once, and says when a cycle overruns the interval', async () => {
    // The bug this guards: overlapping cycles assemble the same parcel concurrently, and
    // assembleParcel opens by `rm -rf`-ing the staging dir — so the later cycle deletes commits/
    // out from under the earlier one's rsync (`mkstemp … No such file or directory`).
    let inFlight = 0
    let maxInFlight = 0
    pollAgentStatus.mockImplementation(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight)
      await new Promise((r) => setTimeout(r, 120))
      inFlight--
    })
    const { reporter, events } = collectingReporter()
    handle = await startServer({ repoRoot: dir, port: 0, pollInterval: 20, reporter })

    await new Promise((r) => setTimeout(r, 700))

    expect(maxInFlight).toBe(1)
    expect(events.some((e) => e.level === 'warn' && e.message.includes('still running'))).toBe(true)
    pollAgentStatus.mockImplementation(async () => {})
  })

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
