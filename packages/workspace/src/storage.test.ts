import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QuimbyError } from '@quimbyhq/errors'
import { getQuimbyDir, getStorageWorkspaceDir } from '@quimbyhq/paths'
import type { QuimbyState } from '@quimbyhq/types'
import { ensureDir, exists, writeYaml } from '@quimbyhq/utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadProjectRegistry, registerProject } from './registry'
import {
  ensureDurableWorkspace,
  listStorageWorkspaces,
  pruneStorageWorkspaces,
  readStoredState,
  removeStorageWorkspace,
  restoreWorkspaceLink,
} from './storage'

let root: string
let repoRoot: string
let originalConfigHome: string | undefined
let originalDataHome: string | undefined

function makeState(id: string): QuimbyState {
  return {
    id,
    sourceRepo: repoRoot,
    sourceRef: 'main',
    snapshot: 'abc123',
    createdAt: '2024-01-01T00:00:00.000Z',
    agents: {},
  } as unknown as QuimbyState
}

// Isolate the durable data root (storage lives at <data>/workspaces/<id>) and user config
// dir (registry) per test. QUIMBY_DATA_HOME wins over XDG_DATA_HOME in getUserDataDir, and
// the shared vitest setup sets both to a per-worker dir, so override them here.
beforeEach(async () => {
  root = join(tmpdir(), `quimby-storage-${crypto.randomUUID()}`)
  repoRoot = join(root, 'repo')
  await mkdir(repoRoot, { recursive: true })
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

describe('ensureDurableWorkspace', () => {
  it('moves an existing repo-local .quimby into storage and links it back', async () => {
    const state = makeState(`ws-${crypto.randomUUID()}`)
    await ensureDir(getQuimbyDir(repoRoot))
    await writeFile(join(getQuimbyDir(repoRoot), 'state.yaml'), 'id: marker')

    const entry = await ensureDurableWorkspace(repoRoot, state)

    expect(entry.id).toBe(state.id)
    expect(entry.repoRoot).toBe(repoRoot)
    expect(entry.storagePath).toBe(getStorageWorkspaceDir(state.id))
    expect((await lstat(getQuimbyDir(repoRoot))).isSymbolicLink()).toBe(true)
    expect(await exists(join(getStorageWorkspaceDir(state.id), 'state.yaml'))).toBe(true)
  })

  it('registers the workspace in the project registry', async () => {
    const state = makeState(`ws-${crypto.randomUUID()}`)
    await ensureDurableWorkspace(repoRoot, state)
    const registry = await loadProjectRegistry()
    expect(registry.projects?.[state.id]?.repoRoot).toBe(repoRoot)
  })

  it('materializes storage even when no repo-local .quimby exists yet', async () => {
    const state = makeState(`ws-${crypto.randomUUID()}`)
    // No .quimby dir in repoRoot; the storage dir is created and linked.
    await ensureDurableWorkspace(repoRoot, state)
    expect(await exists(getStorageWorkspaceDir(state.id))).toBe(true)
    expect((await lstat(getQuimbyDir(repoRoot))).isSymbolicLink()).toBe(true)
  })
})

describe('listStorageWorkspaces', () => {
  it('returns an empty list when nothing is registered or on disk', async () => {
    expect(await listStorageWorkspaces()).toEqual([])
  })

  it('marks a registered workspace with existing storage as exists=true', async () => {
    const state = makeState(`ws-${crypto.randomUUID()}`)
    await ensureDurableWorkspace(repoRoot, state)
    const workspaces = await listStorageWorkspaces()
    const found = workspaces.find((w) => w.id === state.id)
    expect(found?.registered).toBe(true)
    expect(found?.exists).toBe(true)
    expect(found?.repoRoot).toBe(repoRoot)
  })

  it('reports a registered workspace whose storage is missing as exists=false', async () => {
    const id = `ws-${crypto.randomUUID()}`
    await registerProject({
      id,
      repoRoot,
      sourceRepo: repoRoot,
      createdAt: '2024-01-01T00:00:00.000Z',
    })
    const found = (await listStorageWorkspaces()).find((w) => w.id === id)
    expect(found?.registered).toBe(true)
    expect(found?.exists).toBe(false)
  })

  it('reports an unregistered storage directory as registered=false, exists=true', async () => {
    const id = `ws-${crypto.randomUUID()}`
    await ensureDir(getStorageWorkspaceDir(id))
    const found = (await listStorageWorkspaces()).find((w) => w.id === id)
    expect(found?.registered).toBe(false)
    expect(found?.exists).toBe(true)
  })

  it('sorts results by id', async () => {
    await ensureDir(getStorageWorkspaceDir('zeta'))
    await ensureDir(getStorageWorkspaceDir('alpha'))
    const ids = (await listStorageWorkspaces()).map((w) => w.id)
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)))
    expect(ids).toContain('alpha')
    expect(ids).toContain('zeta')
  })
})

describe('pruneStorageWorkspaces', () => {
  it('reports stale (unregistered, on-disk) workspaces without removing them by default', async () => {
    const id = `ws-${crypto.randomUUID()}`
    await ensureDir(getStorageWorkspaceDir(id))
    const stale = await pruneStorageWorkspaces()
    expect(stale.map((w) => w.id)).toContain(id)
    expect(await exists(getStorageWorkspaceDir(id))).toBe(true)
  })

  it('removes stale workspaces when force is set', async () => {
    const id = `ws-${crypto.randomUUID()}`
    await ensureDir(getStorageWorkspaceDir(id))
    const stale = await pruneStorageWorkspaces({ force: true })
    expect(stale.map((w) => w.id)).toContain(id)
    expect(await exists(getStorageWorkspaceDir(id))).toBe(false)
  })

  it('does not treat a registered workspace as stale', async () => {
    const state = makeState(`ws-${crypto.randomUUID()}`)
    await ensureDurableWorkspace(repoRoot, state)
    const stale = await pruneStorageWorkspaces({ force: true })
    expect(stale.map((w) => w.id)).not.toContain(state.id)
    expect(await exists(getStorageWorkspaceDir(state.id))).toBe(true)
  })
})

describe('readStoredState', () => {
  it('reads a workspace state.yaml from durable storage', async () => {
    const id = `ws-${crypto.randomUUID()}`
    await ensureDir(getStorageWorkspaceDir(id))
    await writeYaml(join(getStorageWorkspaceDir(id), 'state.yaml'), makeState(id))
    const state = await readStoredState(id)
    expect(state.id).toBe(id)
    expect(state.sourceRef).toBe('main')
  })

  it('rejects when the stored state does not exist', async () => {
    await expect(readStoredState(`ws-${crypto.randomUUID()}`)).rejects.toThrow()
  })
})

describe('removeStorageWorkspace', () => {
  it('removes the storage directory, unregisters, and reports it existed', async () => {
    const state = makeState(`ws-${crypto.randomUUID()}`)
    await ensureDurableWorkspace(repoRoot, state)
    expect(await exists(getStorageWorkspaceDir(state.id))).toBe(true)

    const existed = await removeStorageWorkspace(state.id)

    expect(existed).toBe(true)
    expect(await exists(getStorageWorkspaceDir(state.id))).toBe(false)
    expect((await loadProjectRegistry()).projects?.[state.id]).toBeUndefined()
  })

  it('reports false when the storage directory was absent', async () => {
    const id = `ws-${crypto.randomUUID()}`
    expect(await removeStorageWorkspace(id)).toBe(false)
  })
})

describe('restoreWorkspaceLink', () => {
  it('returns null when no registry entry matches', async () => {
    expect(await restoreWorkspaceLink(repoRoot)).toBeNull()
  })

  it('relinks a repo to its registered storage after the local .quimby is deleted', async () => {
    const state = makeState(`ws-${crypto.randomUUID()}`)
    await ensureDurableWorkspace(repoRoot, state)
    await rm(getQuimbyDir(repoRoot), { recursive: true, force: true })
    expect(await exists(getQuimbyDir(repoRoot))).toBe(false)

    const entry = await restoreWorkspaceLink(repoRoot)

    expect(entry?.id).toBe(state.id)
    expect((await lstat(getQuimbyDir(repoRoot))).isSymbolicLink()).toBe(true)
  })

  it('matches by explicit id query', async () => {
    const state = makeState(`ws-${crypto.randomUUID()}`)
    await ensureDurableWorkspace(repoRoot, state)
    await rm(getQuimbyDir(repoRoot), { recursive: true, force: true })
    const entry = await restoreWorkspaceLink(repoRoot, { id: state.id })
    expect(entry?.id).toBe(state.id)
  })

  it('throws when multiple registry entries match the same repo root', async () => {
    const now = '2024-01-01T00:00:00.000Z'
    await registerProject({ id: 'ws-one', repoRoot, sourceRepo: '/src/one', createdAt: now })
    await registerProject({ id: 'ws-two', repoRoot, sourceRepo: '/src/two', createdAt: now })
    await expect(restoreWorkspaceLink(repoRoot)).rejects.toThrow(QuimbyError)
  })

  it('throws when the matched workspace storage is missing', async () => {
    const id = `ws-${crypto.randomUUID()}`
    await registerProject({
      id,
      repoRoot,
      sourceRepo: repoRoot,
      createdAt: '2024-01-01T00:00:00.000Z',
    })
    // Registered but storage was never materialized.
    await expect(restoreWorkspaceLink(repoRoot, { id })).rejects.toThrow(/missing/)
  })

  it('throws when the repo already has a non-symlink .quimby in the way', async () => {
    const state = makeState(`ws-${crypto.randomUUID()}`)
    await ensureDurableWorkspace(repoRoot, state)
    // Replace the symlink with a real directory to block relinking.
    await rm(getQuimbyDir(repoRoot), { recursive: true, force: true })
    await ensureDir(getQuimbyDir(repoRoot))
    await expect(restoreWorkspaceLink(repoRoot, { id: state.id })).rejects.toThrow(/already exists/)
  })
})
