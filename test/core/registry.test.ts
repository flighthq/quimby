import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  loadRegistry,
  saveRegistry,
  addToRegistry,
  findInRegistry,
} from '../../src/core/registry.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-registry-test-'))
  process.env.AO_HOME = tmp
})

afterEach(async () => {
  delete process.env.AO_HOME
  await rm(tmp, { recursive: true, force: true })
})

describe('loadRegistry', () => {
  it('returns empty registry when file does not exist', async () => {
    const registry = await loadRegistry()
    expect(registry.workspaces).toEqual([])
  })
})

describe('saveRegistry', () => {
  it('writes and reads back registry', async () => {
    await saveRegistry({
      workspaces: [
        { name: 'test', sourceRepo: '/repo', path: '/ws', createdAt: '2024-01-01T00:00:00Z' },
      ],
    })
    const loaded = await loadRegistry()
    expect(loaded.workspaces).toHaveLength(1)
    expect(loaded.workspaces[0].name).toBe('test')
  })
})

describe('addToRegistry', () => {
  it('adds a new entry', async () => {
    await addToRegistry({
      name: 'proj',
      sourceRepo: '/my/repo',
      path: '/ws/proj',
      createdAt: '2024-01-01T00:00:00Z',
    })
    const registry = await loadRegistry()
    expect(registry.workspaces).toHaveLength(1)
    expect(registry.workspaces[0].name).toBe('proj')
  })

  it('upserts existing entry by name', async () => {
    await addToRegistry({
      name: 'proj',
      sourceRepo: '/old',
      path: '/ws/proj',
      createdAt: '2024-01-01T00:00:00Z',
    })
    await addToRegistry({
      name: 'proj',
      sourceRepo: '/new',
      path: '/ws/proj',
      createdAt: '2024-06-01T00:00:00Z',
    })
    const registry = await loadRegistry()
    expect(registry.workspaces).toHaveLength(1)
    expect(registry.workspaces[0].sourceRepo).toBe('/new')
  })
})

describe('findInRegistry', () => {
  it('finds entry by sourceRepo', async () => {
    await addToRegistry({
      name: 'proj',
      sourceRepo: 'git@github.com:user/repo.git',
      path: '/ws',
      createdAt: '2024-01-01T00:00:00Z',
    })
    const entry = await findInRegistry('git@github.com:user/repo.git')
    expect(entry?.name).toBe('proj')
  })

  it('returns undefined when not found', async () => {
    const entry = await findInRegistry('nonexistent')
    expect(entry).toBeUndefined()
  })
})
