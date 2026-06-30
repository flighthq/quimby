import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAll, commit, init, tag } from '@quimbyhq/git'
import {
  getAgentDir,
  getAgentOutboxDraftDir,
  getAgentOutboxSentDraftDir,
  getAgentRepoDir,
} from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { markHandoffSent, readOutboxDraft, readOutboxRecipients } from './outbox'

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
  const repoRoot = join(tmpdir(), `quimby-outbox-${crypto.randomUUID()}`)
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

beforeEach(async () => {
  dir = await setupRepoRoot()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('markHandoffSent', () => {
  it('is a no-op when the draft does not exist', async () => {
    await expect(markHandoffSent(dir, 'ghost', 'builder')).resolves.toBeUndefined()
  })

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

describe('readOutboxDraft', () => {
  it('returns an empty note when no README.md is staged', async () => {
    await setupAgentRepo(dir, 'review')
    await mkdir(getAgentOutboxDraftDir(dir, 'review', 'builder'), { recursive: true })
    const parsed = await readOutboxDraft(dir, 'review', 'builder')
    expect(parsed.note).toBe('')
    expect(parsed.attach).toBeUndefined()
  })

  it('parses the note and an attach: code source from frontmatter', async () => {
    await setupAgentRepo(dir, 'review')
    const draft = getAgentOutboxDraftDir(dir, 'review', 'integration')
    await mkdir(draft, { recursive: true })
    await writeFile(join(draft, 'README.md'), '---\nattach: builder\n---\npromote this work')
    const parsed = await readOutboxDraft(dir, 'review', 'integration')
    expect(parsed.attach).toBe('builder')
    expect(parsed.note).toBe('promote this work')
  })

  it('strips frontmatter but returns no attach when no attach: key is present', async () => {
    await setupAgentRepo(dir, 'review')
    const draft = getAgentOutboxDraftDir(dir, 'review', 'builder')
    await mkdir(draft, { recursive: true })
    await writeFile(join(draft, 'README.md'), '---\nsome: metadata\n---\nclean up the null case')
    const parsed = await readOutboxDraft(dir, 'review', 'builder')
    expect(parsed.attach).toBeUndefined()
    expect(parsed.note).toBe('clean up the null case')
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
