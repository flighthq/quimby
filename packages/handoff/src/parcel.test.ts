import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAll, commit, init, tag } from '@quimbyhq/git'
import {
  getAgentDir,
  getAgentInboxParcelDir,
  getAgentRepoDir,
  getStagingHandoffDir,
} from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { assembleHandoff } from './assemble'
import { deliverHandoff, discardHandoff, readHandoff } from './parcel'

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
  const repoRoot = join(tmpdir(), `quimby-parcel-${crypto.randomUUID()}`)
  await mkdir(repoRoot, { recursive: true })
  await execa('git', ['init'], { cwd: repoRoot })
  await configureGit(repoRoot)
  await writeFile(join(repoRoot, 'README.md'), '# Project')
  await execa('git', ['add', '-A'], { cwd: repoRoot })
  await execa('git', ['commit', '-m', 'initial'], { cwd: repoRoot })
  await ensureWorkspace(repoRoot)
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

beforeEach(async () => {
  dir = await setupRepoRoot()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('deliverHandoff', () => {
  it('carries a staged parcel into the recipient inbox', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    await setupAgentRepo(dir, 'receiver')
    const meta = await assembleHandoff({
      repoRoot: dir,
      from: 'alice',
      codeSourceId: 'alice',
      to: 'receiver',
    })
    await deliverHandoff({
      repoRoot: dir,
      name: meta.name,
      to: 'receiver',
      toId: 'receiver',
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
        toId: 'receiver',
        toLocation: undefined,
        projectId: 'proj',
      }),
    ).rejects.toThrow('not found')
  })
})

describe('discardHandoff', () => {
  it('is a no-op when the parcel does not exist', async () => {
    await expect(discardHandoff(dir, 'ghost-00000000')).resolves.toBeUndefined()
  })

  it('removes a staged parcel', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    expect(await exists(getStagingHandoffDir(dir, meta.name))).toBe(true)
    await discardHandoff(dir, meta.name)
    expect(await exists(getStagingHandoffDir(dir, meta.name))).toBe(false)
  })
})

describe('readHandoff', () => {
  it('returns meta, diff, and note', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const created = await assembleHandoff({
      repoRoot: dir,
      from: 'alice',
      codeSourceId: 'alice',
      note: 'have a look',
    })
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
