import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentDir, getQuimbyDir, getStatePath, getStorageWorkspaceDir } from '@quimbyhq/paths'
import { ensureDir, exists, writeYaml } from '@quimbyhq/utils'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadProjectRegistry } from './registry'
import { loadState } from './state'
import { ensureWorkspace, resolveWorkspace } from './workspace'

let dir: string
let originalCwd: string
// Durable storage is machine-wide and keyed by workspace id, so a literal id shared across tests
// makes each one inherit the previous test's storage — a collision the code now (correctly)
// refuses rather than silently running unlinked.
let wsId: string

async function setupGitRepo(repoDir: string) {
  await mkdir(repoDir, { recursive: true })
  await execa('git', ['init'], { cwd: repoDir })
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir })
  await writeFile(join(repoDir, 'README.md'), '# Test')
  await execa('git', ['add', '-A'], { cwd: repoDir })
  await execa('git', ['commit', '-m', 'initial'], { cwd: repoDir })
}

beforeEach(async () => {
  wsId = crypto.randomUUID()
  dir = join(tmpdir(), `quimby-ws-${crypto.randomUUID()}`)
  originalCwd = process.cwd()
  await setupGitRepo(dir)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(dir, { recursive: true, force: true })
})

describe('ensureWorkspace', () => {
  it('backfills a missing agent syncRef from the workspace sourceRef', async () => {
    await ensureDir(join(dir, '.quimby'))
    await writeYaml(getStatePath(dir), {
      id: wsId,
      sourceRepo: dir,
      sourceRef: 'main',
      snapshot: 'abc123',
      createdAt: '2024-01-01T00:00:00.000Z',
      agents: {
        alice: {
          id: 'alice-id',
          name: 'alice',
          seedCommit: 'abc123',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      },
    })
    process.chdir(dir)
    const { state } = await resolveWorkspace()
    expect(state.agents.alice.syncRef).toBe('main')
  })

  it('creates state.yaml and .gitignore on first call', async () => {
    const state = await ensureWorkspace(dir)
    expect(await exists(getStatePath(dir))).toBe(true)
    expect(await exists(join(dir, '.gitignore'))).toBe(true)
    expect((await lstat(getQuimbyDir(dir))).isSymbolicLink()).toBe(true)
    expect(await exists(join(getStorageWorkspaceDir(state.id), 'state.yaml'))).toBe(true)
    expect((await loadProjectRegistry()).projects?.[state.id]?.repoRoot).toBe(dir)
  })

  it('is idempotent — does not overwrite existing state', async () => {
    const first = await ensureWorkspace(dir)
    const second = await ensureWorkspace(dir)
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
  })

  it('appends .quimby to an existing .gitignore that does not already include it', async () => {
    await writeFile(join(dir, '.gitignore'), '*.log\nnode_modules\n')
    await ensureWorkspace(dir)
    const content = await import('node:fs/promises').then((m) =>
      m.readFile(join(dir, '.gitignore'), 'utf-8'),
    )
    expect(content).toContain('.quimby')
    expect(content).toContain('*.log')
  })

  it('does not duplicate .quimby when it is already in .gitignore', async () => {
    await writeFile(join(dir, '.gitignore'), '*.log\n.quimby\n')
    await ensureWorkspace(dir)
    const content = await import('node:fs/promises').then((m) =>
      m.readFile(join(dir, '.gitignore'), 'utf-8'),
    )
    const count = content.split('\n').filter((l) => l.trim() === '.quimby').length
    expect(count).toBe(1)
  })

  it('migrates state missing id fields by adding stable UUIDs', async () => {
    await ensureDir(join(dir, '.quimby'))
    await writeYaml(getStatePath(dir), {
      sourceRepo: dir,
      sourceRef: 'main',
      snapshot: 'abc123',
      createdAt: '2024-01-01T00:00:00.000Z',
      agents: {
        alice: {
          name: 'alice',
          seedCommit: 'abc123',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      },
    })
    process.chdir(dir)
    const { state } = await resolveWorkspace()
    expect(state.id).toBeDefined()
    expect(state.agents.alice.id).toBeDefined()
  })

  it('migrates an existing repo-local .quimby directory into durable storage', async () => {
    const projectId = `ws-local-${crypto.randomUUID()}`
    await ensureDir(join(dir, '.quimby'))
    await writeYaml(getStatePath(dir), {
      id: projectId,
      sourceRepo: dir,
      sourceRef: 'main',
      snapshot: 'abc123',
      createdAt: '2024-01-01T00:00:00.000Z',
      agents: {},
    })

    await ensureWorkspace(dir)

    expect((await lstat(getQuimbyDir(dir))).isSymbolicLink()).toBe(true)
    expect(await exists(join(getStorageWorkspaceDir(projectId), 'state.yaml'))).toBe(true)
  })
})

describe('resolveWorkspace', () => {
  it('resolves the repo root and quimby dir from a git repo', async () => {
    await ensureWorkspace(dir)
    process.chdir(dir)
    const { state, repoRoot } = await resolveWorkspace()
    expect(repoRoot).toBe(dir)
    expect(state.agents).toBeDefined()
  })

  it('restores the repo-local .quimby link from the registry after it is deleted', async () => {
    const created = await ensureWorkspace(dir)
    await rm(getQuimbyDir(dir), { recursive: true, force: true })
    expect(await exists(getQuimbyDir(dir))).toBe(false)

    process.chdir(dir)
    const { state } = await resolveWorkspace()

    expect(state.id).toBe(created.id)
    expect((await lstat(getQuimbyDir(dir))).isSymbolicLink()).toBe(true)
    expect(await exists(getStatePath(dir))).toBe(true)
  })

  // `sourceRepo` is this workspace's identity for registry AND remote-adoption matching, and it was
  // written once at creation. A repository renamed on its host therefore kept claiming an origin it
  // no longer pointed at — and a genuinely different project that later took the old name matched
  // it on both surfaces at once.
  it('refreshes a stale sourceRepo from the git origin, and persists it', async () => {
    const created = await ensureWorkspace(dir)
    await execa('git', ['remote', 'add', 'origin', 'https://example.test/renamed.git'], {
      cwd: dir,
    })

    process.chdir(dir)
    const { state } = await resolveWorkspace()

    expect(state.id).toBe(created.id)
    expect(state.sourceRepo).toBe('https://example.test/renamed.git')
    expect((await loadState(dir)).sourceRepo).toBe('https://example.test/renamed.git')
  })

  it('carries the refreshed origin into the registry, which is what adoption matches on', async () => {
    const created = await ensureWorkspace(dir)
    await execa('git', ['remote', 'add', 'origin', 'https://example.test/renamed.git'], {
      cwd: dir,
    })

    process.chdir(dir)
    await resolveWorkspace()

    const registry = await loadProjectRegistry()
    expect(registry.projects?.[created.id]?.sourceRepo).toBe('https://example.test/renamed.git')
  })

  it('leaves sourceRepo alone when the repo has no remote — that is not a different project', async () => {
    // The creation-time fallback for a remote-less repo is the repo PATH, and overwriting a real
    // URL with it (or clobbering it on every resolve) would be the same staleness in reverse.
    await ensureDir(join(dir, '.quimby'))
    await writeYaml(getStatePath(dir), {
      id: wsId,
      sourceRepo: 'https://example.test/original.git',
      sourceRef: 'main',
      snapshot: 'abc123',
      createdAt: '2024-01-01T00:00:00.000Z',
      agents: {},
    })
    process.chdir(dir)
    const { state } = await resolveWorkspace()
    expect(state.sourceRepo).toBe('https://example.test/original.git')
  })

  it('re-points a path-based sourceRepo at the moved checkout, since there the path IS the identity', async () => {
    // A remote-less project stores its own repoRoot as `sourceRepo`. Rename the checkout and that
    // value still names a location another project can now occupy — the same staleness, one
    // identifier over, and the one the registry falls back to when the path match is rejected.
    await ensureDir(join(dir, '.quimby'))
    await writeYaml(getStatePath(dir), {
      id: wsId,
      sourceRepo: '/somewhere/it/used/to/live',
      sourceRef: 'main',
      snapshot: 'abc123',
      createdAt: '2024-01-01T00:00:00.000Z',
      agents: {},
    })
    process.chdir(dir)
    const { state } = await resolveWorkspace()
    expect(state.sourceRepo).toBe(dir)
  })

  it('migrates legacy schema keys (workers, defaults.agent) and preserves advisory checks', async () => {
    await ensureDir(join(dir, '.quimby'))
    await writeYaml(getStatePath(dir), {
      id: wsId,
      sourceRepo: dir,
      sourceRef: 'main',
      snapshot: 'abc123',
      createdAt: '2024-01-01T00:00:00.000Z',
      workers: {
        alice: {
          id: 'alice-id',
          name: 'alice',
          seedCommit: 'abc123',
          createdAt: '2024-01-01T00:00:00.000Z',
          defaults: { runtime: 'sbx', agent: 'claude' },
          check: 'npm run ci',
        },
      },
    })
    process.chdir(dir)
    const { state } = await resolveWorkspace()
    expect((state as unknown as Record<string, unknown>).workers).toBeUndefined()
    expect(state.agents.alice.defaults?.entrypoint).toBe('claude')
    expect(
      (state.agents.alice.defaults as unknown as Record<string, unknown>).agent,
    ).toBeUndefined()
    expect(state.agents.alice.check).toBe('npm run ci')

    // Persisted: a fresh load sees the migrated shape with no further changes.
    const reloaded = await loadState(dir)
    expect(reloaded.agents.alice.defaults?.entrypoint).toBe('claude')
    expect(reloaded.agents.alice.check).toBe('npm run ci')
  })

  it('migrates a legacy inbox/outbox mailbox into the handoff/ tree, idempotently', async () => {
    await ensureDir(join(dir, '.quimby'))
    await writeYaml(getStatePath(dir), {
      id: wsId,
      sourceRepo: dir,
      sourceRef: 'main',
      snapshot: 'abc123',
      createdAt: '2024-01-01T00:00:00.000Z',
      agents: {
        alice: {
          id: 'alice-id',
          name: 'alice',
          seedCommit: 'abc123',
          syncRef: 'main',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      },
    })
    const agentDir = getAgentDir(dir, 'alice-id')
    // A legacy mailbox: a queued outbox draft, its .sent ledger, a delivered inbox parcel, a
    // processed .done archive entry, and a status mirror file.
    await ensureDir(join(agentDir, 'outbox', 'builder'))
    await writeFile(join(agentDir, 'outbox', 'builder', 'README.md'), 'fix Y')
    await ensureDir(join(agentDir, 'outbox', '.sent', 'integration'))
    await writeFile(join(agentDir, 'outbox', '.sent', 'integration', 'README.md'), 'shipped')
    await ensureDir(join(agentDir, 'inbox', 'host-abc123'))
    await writeFile(join(agentDir, 'inbox', 'host-abc123', 'meta.yaml'), 'name: host-abc123')
    await ensureDir(join(agentDir, 'inbox', '.done', 'review-old'))
    await ensureDir(join(agentDir, 'inbox', 'status'))
    await writeFile(join(agentDir, 'inbox', 'status', 'backend.md'), '# Status: backend')

    process.chdir(dir)
    await resolveWorkspace()

    // New tree populated per the mapping…
    expect(await exists(join(agentDir, 'handoff', 'out', 'queued', 'builder', 'README.md'))).toBe(
      true,
    )
    expect(await exists(join(agentDir, 'handoff', 'out', 'sent', 'integration', 'README.md'))).toBe(
      true,
    )
    expect(
      await exists(join(agentDir, 'handoff', 'in', 'received', 'host-abc123', 'meta.yaml')),
    ).toBe(true)
    expect(await exists(join(agentDir, 'handoff', 'in', 'processed', 'review-old'))).toBe(true)
    expect(await exists(join(agentDir, 'status', 'backend.md'))).toBe(true)
    // …and the legacy trees are gone.
    expect(await exists(join(agentDir, 'inbox'))).toBe(false)
    expect(await exists(join(agentDir, 'outbox'))).toBe(false)

    // Idempotent: a second load with the migrated tree in place changes nothing and does not throw.
    await resolveWorkspace()
    expect(await exists(join(agentDir, 'handoff', 'out', 'queued', 'builder', 'README.md'))).toBe(
      true,
    )
    expect(await exists(join(agentDir, 'inbox'))).toBe(false)
  })

  it('throws when called outside a git repo', async () => {
    const notARepo = join(tmpdir(), `not-repo-${crypto.randomUUID()}`)
    await mkdir(notARepo, { recursive: true })
    process.chdir(notARepo)
    try {
      await expect(resolveWorkspace()).rejects.toThrow('Not inside a git repository')
    } finally {
      await rm(notARepo, { recursive: true, force: true })
    }
  })

  it('throws when no state.yaml exists', async () => {
    process.chdir(dir)
    await expect(resolveWorkspace()).rejects.toThrow('No quimby workspace found')
  })
})
