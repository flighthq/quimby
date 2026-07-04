import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentDir, getAgentStatusMirrorDir } from '@quimbyhq/paths'
import type { QuimbyState } from '@quimbyhq/types'
import { exists, readText } from '@quimbyhq/utils'
import { ensureWorkspace, loadState } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const readFile = vi.hoisted(() => vi.fn(async () => ''))
vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getTransport: () => ({
    readFile,
    ensureDir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
  }),
}))

import type { StatusSnapshot } from './poller'
import { getFileMtime, pollAgentStatus, reloadStateIfChanged } from './poller'

let dir: string

function stateWith(agents: Record<string, { id: string; location?: unknown }>): QuimbyState {
  const built: Record<string, unknown> = {}
  for (const [name, a] of Object.entries(agents)) {
    built[name] = { id: a.id, name, location: a.location ?? { type: 'local' } }
  }
  return { id: 'proj', sourceRef: 'main', agents: built } as unknown as QuimbyState
}

async function writeStatus(agentId: string, content: string): Promise<void> {
  const agentDir = getAgentDir(dir, agentId)
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'status.md'), content)
}

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-poller-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
  await execa('git', ['init'], { cwd: dir })
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: dir })
  await writeFile(join(dir, 'README.md'), '# test')
  await execa('git', ['add', '-A'], { cwd: dir })
  await execa('git', ['commit', '-m', 'initial'], { cwd: dir })
  vi.clearAllMocks()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('getFileMtime', () => {
  it('returns null for a missing file', async () => {
    expect(await getFileMtime(join(dir, 'nope'))).toBeNull()
  })

  it('returns a number for an existing file', async () => {
    await writeStatus('b1', 'x')
    expect(typeof (await getFileMtime(join(getAgentDir(dir, 'b1'), 'status.md')))).toBe('number')
  })
})

describe('pollAgentStatus', () => {
  it('seeds the cache on first sighting without mirroring (no spam on server start)', async () => {
    await writeStatus('b1', 'working')
    await mkdir(getAgentStatusMirrorDir(dir, 'r1'), { recursive: true })
    const cache = new Map<string, StatusSnapshot>()

    await pollAgentStatus(
      dir,
      stateWith({ backend: { id: 'b1' }, reviewer: { id: 'r1' } }),
      'backend',
      cache,
    )

    expect(cache.get('backend')?.content).toBe('working')
    expect(await exists(join(getAgentStatusMirrorDir(dir, 'r1'), 'backend.md'))).toBe(false)
  })

  it('mirrors a changed status into every other agent, no subscription needed', async () => {
    await writeStatus('b1', 'changed')
    const cache = new Map<string, StatusSnapshot>([['backend', { content: 'old', mtime: 1 }]])

    await pollAgentStatus(
      dir,
      stateWith({ backend: { id: 'b1' }, reviewer: { id: 'r1' }, other: { id: 'o1' } }),
      'backend',
      cache,
    )

    // Every peer gets the snapshot — the always-mirror model, replacing subscribe-based routing.
    for (const peer of ['r1', 'o1']) {
      const mirrored = await readText(join(getAgentStatusMirrorDir(dir, peer), 'backend.md'))
      expect(mirrored).toContain('changed')
      expect(mirrored).toContain('# Status: backend')
    }
    // The source never mirrors to itself.
    expect(await exists(join(getAgentStatusMirrorDir(dir, 'b1'), 'backend.md'))).toBe(false)
  })

  it('skips when the mtime is unchanged', async () => {
    await writeStatus('b1', 'same')
    const mtime = (await getFileMtime(join(getAgentDir(dir, 'b1'), 'status.md')))!
    const cache = new Map<string, StatusSnapshot>([['backend', { content: 'same', mtime }]])

    await pollAgentStatus(
      dir,
      stateWith({ backend: { id: 'b1' }, reviewer: { id: 'r1' } }),
      'backend',
      cache,
    )

    expect(await exists(join(getAgentStatusMirrorDir(dir, 'r1'), 'backend.md'))).toBe(false)
  })

  it('returns quietly when the status file is missing', async () => {
    const cache = new Map<string, StatusSnapshot>()
    await pollAgentStatus(dir, stateWith({ backend: { id: 'b1' } }), 'backend', cache)
    expect(cache.has('backend')).toBe(false)
  })

  it('detects an SSH agent change by content comparison (no mtime)', async () => {
    readFile.mockResolvedValue('remote-status')
    await mkdir(getAgentStatusMirrorDir(dir, 'r1'), { recursive: true })
    const cache = new Map<string, StatusSnapshot>([
      ['backend', { content: 'old-remote', mtime: 0 }],
    ])
    const state = stateWith({
      backend: { id: 'b1', location: { type: 'ssh', host: 'box', base: '~' } },
      reviewer: { id: 'r1' },
    })

    await pollAgentStatus(dir, state, 'backend', cache)

    expect(cache.get('backend')?.content).toBe('remote-status')
    expect(await exists(join(getAgentStatusMirrorDir(dir, 'r1'), 'backend.md'))).toBe(true)
  })
})

describe('reloadStateIfChanged', () => {
  it('reloads when the state mtime differs from the last seen', async () => {
    await ensureWorkspace(dir)
    const current = await loadState(dir)
    const reloaded = await reloadStateIfChanged(dir, current, 0)
    expect(reloaded).not.toBe(current)
    expect(reloaded.id).toBe(current.id)
  })

  it('keeps the current state when the mtime is unchanged', async () => {
    await ensureWorkspace(dir)
    const current = await loadState(dir)
    const path = join(dir, '.quimby', 'state.yaml')
    const mtime = (await getFileMtime(path))!
    expect(await reloadStateIfChanged(dir, current, mtime)).toBe(current)
  })
})
