import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getProjectRegistryPath, getStorageWorkspaceDir } from '@quimbyhq/paths'
import { exists, readYaml } from '@quimbyhq/utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ProjectRegistry } from './registry'
import {
  findRegistryMatches,
  listRegistryProjects,
  loadProjectRegistry,
  registerProject,
  saveProjectRegistry,
  unregisterProject,
} from './registry'

let root: string
let originalConfigHome: string | undefined
let originalDataHome: string | undefined

// Isolate the user config dir (registry lives at <config>/quimby/projects.yaml) and the
// durable data root per test. QUIMBY_DATA_HOME wins over XDG_DATA_HOME in getUserDataDir,
// and the shared vitest setup sets both to a per-worker dir, so override them here.
beforeEach(async () => {
  root = join(tmpdir(), `quimby-registry-${crypto.randomUUID()}`)
  await mkdir(root, { recursive: true })
  originalConfigHome = process.env.XDG_CONFIG_HOME
  originalDataHome = process.env.QUIMBY_DATA_HOME
  process.env.XDG_CONFIG_HOME = join(root, 'config')
  process.env.QUIMBY_DATA_HOME = join(root, 'data')
})

afterEach(async () => {
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalConfigHome
  if (originalDataHome === undefined) delete process.env.QUIMBY_DATA_HOME
  else process.env.QUIMBY_DATA_HOME = originalDataHome
  await rm(root, { recursive: true, force: true })
})

function makeRegistry(...ids: string[]): ProjectRegistry {
  return {
    projects: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          id,
          repoRoot: `/repos/${id}`,
          sourceRepo: `/src/${id}`,
          sourceRef: 'main',
          storagePath: getStorageWorkspaceDir(id),
          createdAt: '2024-01-01T00:00:00.000Z',
          lastSeenAt: '2024-01-02T00:00:00.000Z',
        },
      ]),
    ),
  }
}

describe('findRegistryMatches', () => {
  it('matches by id, ignoring other criteria', () => {
    const registry = makeRegistry('a', 'b')
    const matches = findRegistryMatches(registry, { id: 'b', repoRoot: '/repos/a' })
    expect(matches.map((m) => m.id)).toEqual(['b'])
  })

  it('prefers repoRoot matches over sourceRepo', () => {
    const registry = makeRegistry('a', 'b')
    const matches = findRegistryMatches(registry, {
      repoRoot: '/repos/a',
      sourceRepo: '/src/b',
    })
    expect(matches.map((m) => m.id)).toEqual(['a'])
  })

  it('falls back to sourceRepo when no repoRoot match', () => {
    const registry = makeRegistry('a', 'b')
    const matches = findRegistryMatches(registry, {
      repoRoot: '/repos/missing',
      sourceRepo: '/src/b',
    })
    expect(matches.map((m) => m.id)).toEqual(['b'])
  })

  it('returns an empty list when nothing matches', () => {
    const registry = makeRegistry('a')
    expect(findRegistryMatches(registry, { repoRoot: '/nope' })).toEqual([])
  })

  it('returns an empty list for an empty query against a populated registry', () => {
    const registry = makeRegistry('a', 'b')
    expect(findRegistryMatches(registry, {})).toEqual([])
  })
})

describe('listRegistryProjects', () => {
  it('returns entries sorted by id', () => {
    const registry = makeRegistry('zeta', 'alpha', 'mid')
    expect(listRegistryProjects(registry).map((e) => e.id)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('returns an empty list when there are no projects', () => {
    expect(listRegistryProjects({})).toEqual([])
    expect(listRegistryProjects({ projects: {} })).toEqual([])
  })

  it('drops malformed entries missing a string id', () => {
    const registry = {
      projects: {
        good: makeRegistry('good').projects?.good,
        bad: { repoRoot: '/x' },
      },
    } as unknown as ProjectRegistry
    expect(listRegistryProjects(registry).map((e) => e.id)).toEqual(['good'])
  })
})

describe('loadProjectRegistry', () => {
  it('returns an empty registry when no file exists', async () => {
    const registry = await loadProjectRegistry()
    expect(registry).toEqual({ projects: {} })
  })

  it('reads a previously saved registry', async () => {
    await saveProjectRegistry(makeRegistry('a', 'b'))
    const registry = await loadProjectRegistry()
    expect(Object.keys(registry.projects ?? {}).sort()).toEqual(['a', 'b'])
  })
})

describe('registerProject', () => {
  it('creates an entry with a computed storagePath and a lastSeenAt', async () => {
    const saved = await registerProject({
      id: 'proj-1',
      repoRoot: '/repos/proj-1',
      sourceRepo: '/src/proj-1',
      sourceRef: 'main',
      createdAt: '2024-01-01T00:00:00.000Z',
    })
    expect(saved.storagePath).toBe(getStorageWorkspaceDir('proj-1'))
    expect(saved.sourceRef).toBe('main')
    expect(saved.lastSeenAt).toBeDefined()
    const onDisk = await readYaml<ProjectRegistry>(getProjectRegistryPath())
    expect(onDisk.projects?.['proj-1']?.repoRoot).toBe('/repos/proj-1')
  })

  it('omits sourceRef when it is not provided', async () => {
    const saved = await registerProject({
      id: 'proj-2',
      repoRoot: '/repos/proj-2',
      sourceRepo: '/src/proj-2',
      createdAt: '2024-01-01T00:00:00.000Z',
    })
    expect('sourceRef' in saved).toBe(false)
  })

  it('preserves the original createdAt on re-registration but refreshes lastSeenAt', async () => {
    const first = await registerProject({
      id: 'proj-3',
      repoRoot: '/repos/proj-3',
      sourceRepo: '/src/proj-3',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastSeenAt: '2024-01-01T00:00:00.000Z',
    })
    const second = await registerProject({
      id: 'proj-3',
      repoRoot: '/repos/moved',
      sourceRepo: '/src/proj-3',
      createdAt: '2025-06-06T00:00:00.000Z',
      lastSeenAt: '2025-06-06T00:00:00.000Z',
    })
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.lastSeenAt).toBe('2025-06-06T00:00:00.000Z')
    expect(second.repoRoot).toBe('/repos/moved')
  })

  it('honors a provided lastSeenAt', async () => {
    const saved = await registerProject({
      id: 'proj-4',
      repoRoot: '/repos/proj-4',
      sourceRepo: '/src/proj-4',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastSeenAt: '2024-03-03T00:00:00.000Z',
    })
    expect(saved.lastSeenAt).toBe('2024-03-03T00:00:00.000Z')
  })
})

describe('saveProjectRegistry', () => {
  it('writes projects to disk, defaulting a missing projects map to empty', async () => {
    await saveProjectRegistry({})
    const onDisk = await readYaml<ProjectRegistry>(getProjectRegistryPath())
    expect(onDisk.projects).toEqual({})
  })

  it('creates the config directory if it does not exist', async () => {
    expect(await exists(getProjectRegistryPath())).toBe(false)
    await saveProjectRegistry(makeRegistry('a'))
    expect(await exists(getProjectRegistryPath())).toBe(true)
  })

  it('round-trips through loadProjectRegistry', async () => {
    await saveProjectRegistry(makeRegistry('x'))
    const loaded = await loadProjectRegistry()
    expect(loaded.projects?.['x']?.storagePath).toBe(getStorageWorkspaceDir('x'))
  })
})

describe('unregisterProject', () => {
  it('removes an existing entry and reports true', async () => {
    await saveProjectRegistry(makeRegistry('a', 'b'))
    expect(await unregisterProject('a')).toBe(true)
    const registry = await loadProjectRegistry()
    expect(Object.keys(registry.projects ?? {})).toEqual(['b'])
  })

  it('reports false for an unknown id and leaves the registry untouched', async () => {
    await saveProjectRegistry(makeRegistry('a'))
    expect(await unregisterProject('missing')).toBe(false)
    const registry = await loadProjectRegistry()
    expect(Object.keys(registry.projects ?? {})).toEqual(['a'])
  })
})
