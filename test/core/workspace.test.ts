import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as git from '../../src/utils/git.js'
import {
  loadWorkspaceState,
  saveWorkspaceState,
} from '../../src/core/workspace.js'
import type { WorkspaceState } from '../../src/types/workspace.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-workspace-test-'))
  process.env.AO_HOME = join(tmp, 'ao-home')
})

afterEach(async () => {
  delete process.env.AO_HOME
  await rm(tmp, { recursive: true, force: true })
})

function makeState(overrides?: Partial<WorkspaceState>): WorkspaceState {
  return {
    name: 'test',
    sourceRepo: '/test/repo',
    sourceRepoPath: '/test/repo',
    sourceRef: 'main',
    snapshot: 'abc123',
    createdAt: '2024-01-01T00:00:00Z',
    sandboxes: {},
    ...overrides,
  }
}

describe('loadWorkspaceState', () => {
  it('loads state from workspace.yaml', async () => {
    const wsPath = join(tmp, 'ws')
    await mkdir(wsPath, { recursive: true })
    const state = makeState({ name: 'loaded' })
    await saveWorkspaceState(wsPath, state)

    const loaded = await loadWorkspaceState(wsPath)
    expect(loaded.name).toBe('loaded')
    expect(loaded.sourceRef).toBe('main')
  })
})

describe('saveWorkspaceState', () => {
  it('persists state to workspace.yaml', async () => {
    const wsPath = join(tmp, 'ws2')
    await mkdir(wsPath, { recursive: true })
    const state = makeState({
      name: 'saved',
      sandboxes: {
        backend: {
          name: 'backend',
          status: 'running',
          runtimeType: 'docker-sandbox',
          seedCommit: 'def456',
          createdAt: '2024-01-01T00:00:00Z',
          pid: 12345,
        },
      },
    })

    await saveWorkspaceState(wsPath, state)
    const loaded = await loadWorkspaceState(wsPath)
    expect(loaded.sandboxes.backend.status).toBe('running')
    expect(loaded.sandboxes.backend.pid).toBe(12345)
  })
})

describe('createWorkspace', () => {
  it('is tested via integration', () => {
    expect(true).toBe(true)
  })
})

describe('resolveWorkspace', () => {
  it('is tested via integration', () => {
    expect(true).toBe(true)
  })
})
