import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAll, commit, init, tag } from '@quimbyhq/git'
import {
  getAgentDir,
  getAgentInboxParcelDir,
  getAgentOutboxDraftDir,
  getAgentOutboxSentDraftDir,
  getAgentRepoDir,
  getStagingHandoffDir,
} from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyHandoff,
  assembleHandoff,
  assembleHostHandoff,
  deliverHandoff,
  discardHandoff,
  markHandoffSent,
  readHandoff,
  readOutboxDraft,
  readOutboxRecipients,
} from './handoff'

vi.mock('@quimbyhq/transport', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    getSSHTransport: vi.fn(() => ({
      exec: vi.fn(async () => ''),
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(),
      fileExists: vi.fn(async () => false),
      ensureDir: vi.fn(),
      rsyncFrom: vi.fn(),
      rsyncTo: vi.fn(),
    })),
  }
})

let dir: string

async function configureGit(cwd: string) {
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd })
}

async function setupRepoRoot(): Promise<string> {
  const repoRoot = join(tmpdir(), `quimby-handoff-${crypto.randomUUID()}`)
  await mkdir(repoRoot, { recursive: true })
  await execa('git', ['init'], { cwd: repoRoot })
  await configureGit(repoRoot)
  await writeFile(join(repoRoot, 'README.md'), '# Project')
  await execa('git', ['add', '-A'], { cwd: repoRoot })
  await execa('git', ['commit', '-m', 'initial'], { cwd: repoRoot })
  await ensureWorkspace(repoRoot)
  // ensureWorkspace gitignores .quimby; commit that so the host working tree is
  // clean (mirrors a real repo, where .quimby never shows up in a capture).
  await execa('git', ['add', '.gitignore'], { cwd: repoRoot })
  await execa('git', ['commit', '-m', 'gitignore .quimby'], { cwd: repoRoot })
  return repoRoot
}

async function setupAgentRepo(repoRoot: string, agentName: string): Promise<string> {
  const agentRepoDir = getAgentRepoDir(repoRoot, agentName)
  const agentDir = getAgentDir(repoRoot, agentName)
  await mkdir(join(agentDir, 'inbox', 'status'), { recursive: true })
  await mkdir(join(agentDir, 'outbox'), { recursive: true })
  await mkdir(agentRepoDir, { recursive: true })
  await init(agentRepoDir)
  await configureGit(agentRepoDir)
  await writeFile(join(agentRepoDir, 'base.txt'), 'base content\n')
  await addAll(agentRepoDir)
  await commit(agentRepoDir, 'base commit')
  await tag(agentRepoDir, 'quimby/seed')
  return agentRepoDir
}

async function withFeatureCommit(agentRepoDir: string): Promise<void> {
  await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
  await addAll(agentRepoDir)
  await commit(agentRepoDir, 'add feature')
}

async function setupTargetRepo(): Promise<string> {
  const targetDir = join(tmpdir(), `quimby-target-${crypto.randomUUID()}`)
  await mkdir(targetDir, { recursive: true })
  await execa('git', ['init'], { cwd: targetDir })
  await configureGit(targetDir)
  await writeFile(join(targetDir, 'base.txt'), 'base content\n')
  await execa('git', ['add', '-A'], { cwd: targetDir })
  await execa('git', ['commit', '-m', 'base commit'], { cwd: targetDir })
  return targetDir
}

beforeEach(async () => {
  dir = await setupRepoRoot()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('applyHandoff', () => {
  for (const mode of ['squashed', 'commits', 'patch'] as const) {
    it(`applies a code parcel to the host repo (${mode} mode)`, async () => {
      const agentRepoDir = await setupAgentRepo(dir, 'alice')
      await withFeatureCommit(agentRepoDir)
      const meta = await assembleHandoff({ repoRoot: dir, from: 'alice' })
      const targetDir = await setupTargetRepo()
      try {
        await applyHandoff({ repoRoot: dir, name: meta.name, targetRepoPath: targetDir, mode })
        expect(await exists(join(targetDir, 'feature.txt'))).toBe(true)
      } finally {
        await rm(targetDir, { recursive: true, force: true })
      }
    })
  }
})

describe('assembleHandoff', () => {
  it('stages a code parcel with squashed.diff and meta.yaml', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice' })
    const parcel = getStagingHandoffDir(dir, meta.name)
    expect(await exists(join(parcel, 'squashed.diff'))).toBe(true)
    expect(await exists(join(parcel, 'meta.yaml'))).toBe(true)
    expect(meta.commits).toHaveLength(1)
  })

  it('names the parcel <from>-<short-sha> of the packed tip', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice' })
    expect(meta.name).toMatch(/^alice-[0-9a-f]{8}$/)
  })

  it('stages a note-only parcel when there is no code', async () => {
    await setupAgentRepo(dir, 'review')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'review', note: 'fix the null case' })
    const parcel = getStagingHandoffDir(dir, meta.name)
    expect(await exists(join(parcel, 'README.md'))).toBe(true)
    expect(await exists(join(parcel, 'squashed.diff'))).toBe(false)
    expect(meta.note).toBe('fix the null case')
    expect(meta.commits).toHaveLength(0)
  })

  it('carries a different code source than the sender (attach)', async () => {
    await setupAgentRepo(dir, 'review')
    const builderRepo = await setupAgentRepo(dir, 'builder')
    await withFeatureCommit(builderRepo)
    const meta = await assembleHandoff({
      repoRoot: dir,
      from: 'review',
      codeSource: 'builder',
      note: 'promote this',
    })
    expect(meta.from).toBe('review')
    expect(meta.codeSource).toBe('builder')
    expect(meta.commits).toHaveLength(1)
    const parcel = getStagingHandoffDir(dir, meta.name)
    expect(await exists(join(parcel, 'squashed.diff'))).toBe(true)
    expect(await exists(join(parcel, 'README.md'))).toBe(true)
  })

  it('throws when there is neither code nor a note', async () => {
    await setupAgentRepo(dir, 'alice')
    await expect(assembleHandoff({ repoRoot: dir, from: 'alice' })).rejects.toThrow(
      'Nothing to hand off',
    )
  })
})

describe('assembleHostHandoff', () => {
  it('stages a parcel from the host working tree against a base', async () => {
    const base = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
    await writeFile(join(dir, 'README.md'), '# Project changed by host')
    const meta = await assembleHostHandoff({
      repoRoot: dir,
      to: 'review',
      base,
      note: 'please look',
    })
    expect(meta.from).toBe('host')
    expect(meta.to).toBe('review')
    const parcel = getStagingHandoffDir(dir, meta.name)
    expect(await exists(join(parcel, 'squashed.diff'))).toBe(true)
    expect(await exists(join(parcel, 'README.md'))).toBe(true)
  })

  it('throws when the host has no changes and no note', async () => {
    const base = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
    await expect(assembleHostHandoff({ repoRoot: dir, to: 'review', base })).rejects.toThrow(
      'Nothing to hand off',
    )
  })
})

describe('assembleRemoteHandoff', () => {
  it('is a function', async () => {
    const { assembleRemoteHandoff } = await import('./handoff')
    expect(typeof assembleRemoteHandoff).toBe('function')
  })
})

describe('deliverHandoff', () => {
  it('carries a staged parcel into the recipient inbox', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    await setupAgentRepo(dir, 'receiver')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', to: 'receiver' })
    await deliverHandoff({
      repoRoot: dir,
      name: meta.name,
      to: 'receiver',
      toLocation: undefined,
      projectId: 'proj',
    })
    const inboxParcel = getAgentInboxParcelDir(dir, 'receiver', meta.name)
    expect(await exists(join(inboxParcel, 'meta.yaml'))).toBe(true)
  })

  it('throws when the parcel has not been staged', async () => {
    await expect(
      deliverHandoff({
        repoRoot: dir,
        name: 'ghost-00000000',
        to: 'receiver',
        toLocation: undefined,
        projectId: 'proj',
      }),
    ).rejects.toThrow('not found')
  })
})

describe('discardHandoff', () => {
  it('removes a staged parcel', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice' })
    expect(await exists(getStagingHandoffDir(dir, meta.name))).toBe(true)
    await discardHandoff(dir, meta.name)
    expect(await exists(getStagingHandoffDir(dir, meta.name))).toBe(false)
  })

  it('is a no-op when the parcel does not exist', async () => {
    await expect(discardHandoff(dir, 'ghost-00000000')).resolves.toBeUndefined()
  })
})

describe('markHandoffSent', () => {
  it('moves an outbox draft into the .sent ledger', async () => {
    await setupAgentRepo(dir, 'review')
    const draft = getAgentOutboxDraftDir(dir, 'review', 'builder')
    await mkdir(draft, { recursive: true })
    await writeFile(join(draft, 'README.md'), 'fix Y')
    await markHandoffSent(dir, 'review', 'builder')
    expect(await exists(draft)).toBe(false)
    expect(
      await exists(join(getAgentOutboxSentDraftDir(dir, 'review', 'builder'), 'README.md')),
    ).toBe(true)
  })
})

describe('readHandoff', () => {
  it('returns meta, diff, and note', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const created = await assembleHandoff({ repoRoot: dir, from: 'alice', note: 'have a look' })
    const { meta, squashedDiff, note } = await readHandoff(dir, created.name)
    expect(meta.name).toBe(created.name)
    expect(meta.from).toBe('alice')
    expect(squashedDiff).toContain('feature')
    expect(note).toBe('have a look')
  })

  it('throws when the parcel does not exist', async () => {
    await expect(readHandoff(dir, 'nonexistent-parcel')).rejects.toThrow('not found')
  })
})

describe('readOutboxDraft', () => {
  it('parses the note and an attach: code source from frontmatter', async () => {
    await setupAgentRepo(dir, 'review')
    const draft = getAgentOutboxDraftDir(dir, 'review', 'integration')
    await mkdir(draft, { recursive: true })
    await writeFile(join(draft, 'README.md'), '---\nattach: builder\n---\npromote this work')
    const parsed = await readOutboxDraft(dir, 'review', 'integration')
    expect(parsed.attach).toBe('builder')
    expect(parsed.note).toBe('promote this work')
  })

  it('returns the raw note when there is no frontmatter', async () => {
    await setupAgentRepo(dir, 'review')
    const draft = getAgentOutboxDraftDir(dir, 'review', 'builder')
    await mkdir(draft, { recursive: true })
    await writeFile(join(draft, 'README.md'), 'just fix it')
    const parsed = await readOutboxDraft(dir, 'review', 'builder')
    expect(parsed.attach).toBeUndefined()
    expect(parsed.note).toBe('just fix it')
  })
})

describe('readOutboxRecipients', () => {
  it('lists recipient drafts and ignores the .sent ledger', async () => {
    await setupAgentRepo(dir, 'review')
    await mkdir(getAgentOutboxDraftDir(dir, 'review', 'builder'), { recursive: true })
    await mkdir(getAgentOutboxDraftDir(dir, 'review', 'integration'), { recursive: true })
    await mkdir(getAgentOutboxSentDraftDir(dir, 'review', 'old'), { recursive: true })
    const recipients = await readOutboxRecipients(dir, 'review')
    expect(recipients).toEqual(['builder', 'integration'])
  })

  it('returns empty when there is no outbox', async () => {
    expect(await readOutboxRecipients(dir, 'ghost')).toEqual([])
  })
})
