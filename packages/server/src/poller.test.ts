import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentDir, getAgentStatusMirrorDir } from '@quimbyhq/paths'
import { collectingReporter } from '@quimbyhq/reporter'
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
import { getFileMtime, pollStatusCycle, reloadStateIfChanged } from './poller'

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

describe('pollStatusCycle', () => {
  it('seeds the cache and mirrors on first sighting, so a newly-seen agent is not swallowed', async () => {
    // A brand-new agent (or one that wrote a substantive status before the server started) is
    // seen exactly once as "new"; that first sighting must flow to peers, not be swallowed.
    await writeStatus('b1', 'working')
    await mkdir(getAgentStatusMirrorDir(dir, 'r1'), { recursive: true })
    const cache = new Map<string, StatusSnapshot>()

    await pollStatusCycle(dir, stateWith({ backend: { id: 'b1' }, reviewer: { id: 'r1' } }), cache)

    expect(cache.get('backend')?.content).toBe('working')
    const mirrored = await readText(join(getAgentStatusMirrorDir(dir, 'r1'), 'backend.md'))
    expect(mirrored).toContain('working')
    expect(mirrored).toContain('# Status: backend')
  })

  it('mirrors a changed status into every other agent, no subscription needed', async () => {
    await writeStatus('b1', 'changed')
    const cache = new Map<string, StatusSnapshot>([['backend', { content: 'old', mtime: 1 }]])

    await pollStatusCycle(
      dir,
      stateWith({ backend: { id: 'b1' }, reviewer: { id: 'r1' }, other: { id: 'o1' } }),
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

    await pollStatusCycle(dir, stateWith({ backend: { id: 'b1' }, reviewer: { id: 'r1' } }), cache)

    expect(await exists(join(getAgentStatusMirrorDir(dir, 'r1'), 'backend.md'))).toBe(false)
  })

  it('returns quietly when the status file is missing', async () => {
    const cache = new Map<string, StatusSnapshot>()
    await pollStatusCycle(dir, stateWith({ backend: { id: 'b1' } }), cache)
    expect(cache.has('backend')).toBe(false)
  })

  it('reports one condensed line per source agent, not one per delivery', async () => {
    // The old shape printed `1 + (N-1)` lines per changed status — N² per cycle, and reprinted in
    // full on every restart since first sighting also mirrors.
    await writeStatus('b1', 'working')
    await writeStatus('r1', 'reviewing')
    const { reporter, events } = collectingReporter()

    await pollStatusCycle(
      dir,
      stateWith({ backend: { id: 'b1' }, reviewer: { id: 'r1' }, other: { id: 'o1' } }),
      new Map<string, StatusSnapshot>(),
      reporter,
    )

    expect(events).toHaveLength(2)
    expect(events.map((e) => e.message).sort()).toEqual([
      '[backend] status → 2 peer(s)',
      '[reviewer] status → 2 peer(s)',
    ])
  })

  it('names a failed recipient individually — condensing must not hide a miss', async () => {
    await writeStatus('b1', 'working')
    const state = stateWith({
      backend: { id: 'b1' },
      // An SSH peer whose transport mock has no `exec`, so its batched delivery throws.
      reviewer: { id: 'r1', location: { type: 'ssh', host: 'box', base: '~' } },
      other: { id: 'o1' },
    })
    const { reporter, events } = collectingReporter()

    await pollStatusCycle(dir, state, new Map<string, StatusSnapshot>(), reporter)

    const warned = events.find((e) => e.level === 'warn')
    expect(warned?.message).toContain('[backend]')
    expect(warned?.message).toContain('1/2 peer(s)')
    expect(warned?.message).toContain('reviewer')
    // The reachable peer still received it — one bad recipient never blocks the others.
    expect(await exists(join(getAgentStatusMirrorDir(dir, 'o1'), 'backend.md'))).toBe(true)
  })

  it('delivers one batched call per recipient carrying every changed peer', async () => {
    // Two sources change in the same cycle; the recipient must get both, and (for SSH) in a single
    // remote call rather than one round trip per file — the N² → N fix.
    await writeStatus('b1', 'working')
    await writeStatus('r1', 'reviewing')

    await pollStatusCycle(
      dir,
      stateWith({ backend: { id: 'b1' }, reviewer: { id: 'r1' }, other: { id: 'o1' } }),
      new Map<string, StatusSnapshot>(),
    )

    expect(await readText(join(getAgentStatusMirrorDir(dir, 'o1'), 'backend.md'))).toContain(
      'working',
    )
    expect(await readText(join(getAgentStatusMirrorDir(dir, 'o1'), 'reviewer.md'))).toContain(
      'reviewing',
    )
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

    await pollStatusCycle(dir, state, cache)

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
