import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentDir, getStatePath } from '@quimbyhq/paths'
import { ensureDir, exists, writeYaml } from '@quimbyhq/utils'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadState } from './state'
import { ensureWorkspace, resolveWorkspace } from './workspace'

let dir: string
let originalCwd: string

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
      id: 'ws-id',
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
    await ensureWorkspace(dir)
    expect(await exists(getStatePath(dir))).toBe(true)
    expect(await exists(join(dir, '.gitignore'))).toBe(true)
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
})

describe('resolveWorkspace', () => {
  it('resolves the repo root and quimby dir from a git repo', async () => {
    await ensureWorkspace(dir)
    process.chdir(dir)
    const { state, repoRoot } = await resolveWorkspace()
    expect(repoRoot).toBe(dir)
    expect(state.agents).toBeDefined()
  })

  it('migrates legacy schema keys (workers, defaults.agent) and drops the retired guard/check', async () => {
    await ensureDir(join(dir, '.quimby'))
    await writeYaml(getStatePath(dir), {
      id: 'ws-id',
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
    // The per-agent guard was retired: quimby runs on the host, outside the agent's
    // sandbox, so it could never run the guard where the agent's deps were installed.
    expect((state.agents.alice as unknown as Record<string, unknown>).guard).toBeUndefined()
    expect((state.agents.alice as unknown as Record<string, unknown>).check).toBeUndefined()

    // Persisted: a fresh load sees the migrated shape with no further changes.
    const reloaded = await loadState(dir)
    expect(reloaded.agents.alice.defaults?.entrypoint).toBe('claude')
    expect((reloaded.agents.alice as unknown as Record<string, unknown>).guard).toBeUndefined()
  })

  it('migrates a legacy inbox/outbox mailbox into the handoff/ tree, idempotently', async () => {
    await ensureDir(join(dir, '.quimby'))
    await writeYaml(getStatePath(dir), {
      id: 'ws-id',
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
