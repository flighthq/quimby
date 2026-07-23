import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAll, commit, init, tag } from '@quimbyhq/git'
import {
  getAgentDir,
  getAgentHandoffOutDraftRecipientDir,
  getAgentHandoffOutQueuedDir,
  getAgentHandoffOutQueuedRecipientDir,
  getAgentHandoffOutSentRecipientDir,
  getAgentRepoDir,
} from '@quimbyhq/paths'
import type { AgentState } from '@quimbyhq/types'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearRemoteOutboxDraft,
  copyOutboxExtraFiles,
  markHandoffSent,
  pickupRemoteOutbox,
  readOutboxDraft,
  readOutboxRecipients,
} from './outbox'

const sshTransport = {
  exec: vi.fn(async () => ''),
  readFile: vi.fn(async () => ''),
  writeFile: vi.fn(),
  fileExists: vi.fn(async () => false),
  ensureDir: vi.fn(),
  rsyncFrom: vi.fn(),
  rsyncTo: vi.fn(),
}

vi.mock('@quimbyhq/transport', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    getSSHTransport: vi.fn(() => sshTransport),
  }
})

function agent(id: string, location: AgentState['location']): AgentState {
  return { id, name: id, seedCommit: 'seed', createdAt: '2026-01-01T00:00:00Z', location }
}

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
  await mkdir(join(agentDir, 'handoff', 'out', 'queued'), { recursive: true })
  await mkdir(join(agentDir, 'handoff', 'in', 'received'), { recursive: true })
  await mkdir(join(agentDir, 'status'), { recursive: true })
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

describe('clearRemoteOutboxDraft', () => {
  it('is a no-op for a local agent (no transport touched)', async () => {
    await clearRemoteOutboxDraft(agent('review', { type: 'local' }), 'proj', 'builder')
    expect(sshTransport.exec).not.toHaveBeenCalled()
  })

  it('moves the remote queued parcel into the remote out/sent ledger', async () => {
    await clearRemoteOutboxDraft(
      agent('9b35cd55', { type: 'ssh', host: 'joshua@box' }),
      'proj',
      'builder',
    )
    expect(sshTransport.exec).toHaveBeenCalledTimes(1)
    const cmd = (sshTransport.exec.mock.calls[0] as unknown as [string])[0]
    expect(cmd).toContain('/agents/9b35cd55/handoff/out')
    expect(cmd).toMatch(/&& mv \S+\/out\/queued\/'builder' \S+\/out\/sent\/'builder'/)
  })
})

describe('copyOutboxExtraFiles', () => {
  it('returns empty when the queued parcel dir does not exist', async () => {
    expect(await copyOutboxExtraFiles(dir, 'ghost', 'builder', join(dir, 'dest'))).toEqual([])
  })

  it('copies the sender-attached files (not the note) into the destination, sorted', async () => {
    await setupAgentRepo(dir, 'review')
    const queued = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder')
    await mkdir(queued, { recursive: true })
    await writeFile(join(queued, 'README.md'), 'the note')
    await writeFile(join(queued, 'brief.md'), '# Brief')
    await writeFile(join(queued, 'data.json'), '{}')
    const destDir = join(dir, 'staging-parcel')
    const copied = await copyOutboxExtraFiles(dir, 'review', 'builder', destDir)
    expect(copied).toEqual(['brief.md', 'data.json'])
    expect(await exists(join(destDir, 'brief.md'))).toBe(true)
    expect(await exists(join(destDir, 'data.json'))).toBe(true)
    // The note travels via the assembler's README.md, not as an extra file.
    expect(await exists(join(destDir, 'README.md'))).toBe(false)
  })

  it('returns empty when the parcel carries only the note', async () => {
    await setupAgentRepo(dir, 'review')
    const queued = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder')
    await mkdir(queued, { recursive: true })
    await writeFile(join(queued, 'README.md'), 'just a note')
    const destDir = join(dir, 'staging-parcel')
    expect(await copyOutboxExtraFiles(dir, 'review', 'builder', destDir)).toEqual([])
  })

  it('never copies a reserved parcel filename (an attachment cannot clobber the diff/manifest)', async () => {
    await setupAgentRepo(dir, 'review')
    const queued = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder')
    await mkdir(queued, { recursive: true })
    await writeFile(join(queued, 'README.md'), 'note')
    await writeFile(join(queued, 'squashed.diff'), 'ATTACKER DIFF')
    await writeFile(join(queued, 'meta.yaml'), 'evil: true')
    await writeFile(join(queued, 'keep.txt'), 'ok')
    const destDir = join(dir, 'staging-parcel')
    const copied = await copyOutboxExtraFiles(dir, 'review', 'builder', destDir)
    expect(copied).toEqual(['keep.txt'])
    expect(await exists(join(destDir, 'squashed.diff'))).toBe(false)
    expect(await exists(join(destDir, 'meta.yaml'))).toBe(false)
  })

  it('ignores directories — only plain files are carried', async () => {
    await setupAgentRepo(dir, 'review')
    const queued = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder')
    await mkdir(join(queued, 'commits'), { recursive: true })
    await writeFile(join(queued, 'commits', '0001.patch'), 'patch')
    await writeFile(join(queued, 'notes.txt'), 'plain')
    const destDir = join(dir, 'staging-parcel')
    const copied = await copyOutboxExtraFiles(dir, 'review', 'builder', destDir)
    expect(copied).toEqual(['notes.txt'])
    expect(await exists(join(destDir, 'commits'))).toBe(false)
  })
})

describe('markHandoffSent', () => {
  it('is a no-op when the queued parcel does not exist', async () => {
    await expect(markHandoffSent(dir, 'ghost', 'builder')).resolves.toBeUndefined()
  })

  it('moves a queued parcel into the out/sent ledger', async () => {
    await setupAgentRepo(dir, 'review')
    const queued = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder')
    await mkdir(queued, { recursive: true })
    await writeFile(join(queued, 'README.md'), 'fix Y')
    await markHandoffSent(dir, 'review', 'builder')
    expect(await exists(queued)).toBe(false)
    expect(
      await exists(join(getAgentHandoffOutSentRecipientDir(dir, 'review', 'builder'), 'README.md')),
    ).toBe(true)
  })
})

describe('pickupRemoteOutbox', () => {
  it('is a no-op for a local agent (no transport touched)', async () => {
    await pickupRemoteOutbox(dir, agent('review', { type: 'local' }), 'proj')
    expect(sshTransport.fileExists).not.toHaveBeenCalled()
    expect(sshTransport.rsyncFrom).not.toHaveBeenCalled()
  })

  it('skips the rsync when the remote outbox does not exist yet', async () => {
    sshTransport.fileExists.mockResolvedValueOnce(false)
    await pickupRemoteOutbox(dir, agent('9b35cd55', { type: 'ssh', host: 'joshua@box' }), 'proj')
    expect(sshTransport.fileExists).toHaveBeenCalledTimes(1)
    expect(sshTransport.rsyncFrom).not.toHaveBeenCalled()
  })

  it('rsyncs the remote out/queued into the local queued dir when it exists', async () => {
    sshTransport.fileExists.mockResolvedValueOnce(true)
    const ssh = agent('9b35cd55', { type: 'ssh', host: 'joshua@box' })
    await pickupRemoteOutbox(dir, ssh, 'proj')
    expect(sshTransport.rsyncFrom).toHaveBeenCalledTimes(1)
    const [remote, local] = sshTransport.rsyncFrom.mock.calls[0] as unknown as [string, string]
    expect(remote).toContain('/agents/9b35cd55/handoff/out/queued')
    expect(local).toContain(getAgentHandoffOutQueuedDir(dir, '9b35cd55'))
  })
})

describe('readOutboxDraft', () => {
  it('returns an empty note when no README.md is staged', async () => {
    await setupAgentRepo(dir, 'review')
    await mkdir(getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder'), { recursive: true })
    const parsed = await readOutboxDraft(dir, 'review', 'builder')
    expect(parsed.note).toBe('')
    expect(parsed.attach).toBeUndefined()
  })

  it('parses the note and an attach: code source from frontmatter', async () => {
    await setupAgentRepo(dir, 'review')
    const draft = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'integration')
    await mkdir(draft, { recursive: true })
    await writeFile(join(draft, 'README.md'), '---\nattach: builder\n---\npromote this work')
    const parsed = await readOutboxDraft(dir, 'review', 'integration')
    expect(parsed.attach).toBe('builder')
    expect(parsed.note).toBe('promote this work')
  })

  it('returns the raw content when frontmatter is unclosed (no closing ---)', async () => {
    await setupAgentRepo(dir, 'review')
    const draft = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder')
    await mkdir(draft, { recursive: true })
    const raw = '---\nattach: builder\nno closing delimiter here'
    await writeFile(join(draft, 'README.md'), raw)
    const parsed = await readOutboxDraft(dir, 'review', 'builder')
    expect(parsed.attach).toBeUndefined()
    expect(parsed.note).toBe(raw)
  })

  it('strips frontmatter but returns no attach when no attach: key is present', async () => {
    await setupAgentRepo(dir, 'review')
    const draft = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder')
    await mkdir(draft, { recursive: true })
    await writeFile(join(draft, 'README.md'), '---\nsome: metadata\n---\nclean up the null case')
    const parsed = await readOutboxDraft(dir, 'review', 'builder')
    expect(parsed.attach).toBeUndefined()
    expect(parsed.note).toBe('clean up the null case')
  })

  it('reads an agent-side delegation claim separately from note text', async () => {
    await setupAgentRepo(dir, 'review')
    const draft = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder')
    await mkdir(draft, { recursive: true })
    await writeFile(join(draft, 'README.md'), '---\ndelegated: true\n---\nreview the API')
    const parsed = await readOutboxDraft(dir, 'review', 'builder')
    expect(parsed).toEqual({
      note: 'review the API',
      attach: undefined,
      delegated: true,
    })
  })

  it('returns the raw note when there is no frontmatter', async () => {
    await setupAgentRepo(dir, 'review')
    const draft = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder')
    await mkdir(draft, { recursive: true })
    await writeFile(join(draft, 'README.md'), 'just fix it')
    const parsed = await readOutboxDraft(dir, 'review', 'builder')
    expect(parsed.attach).toBeUndefined()
    expect(parsed.note).toBe('just fix it')
  })
})

describe('readOutboxRecipients', () => {
  it('lists queued recipients (the sent ledger is a separate tree)', async () => {
    await setupAgentRepo(dir, 'review')
    await mkdir(getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder'), { recursive: true })
    await mkdir(getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'integration'), {
      recursive: true,
    })
    await mkdir(getAgentHandoffOutSentRecipientDir(dir, 'review', 'old'), { recursive: true })
    const recipients = await readOutboxRecipients(dir, 'review')
    expect(recipients).toEqual(['builder', 'integration'])
  })

  it('returns empty when there is no queue', async () => {
    expect(await readOutboxRecipients(dir, 'ghost')).toEqual([])
  })

  it('scans out/queued only — a parcel still in out/draft is never dispatched', async () => {
    await setupAgentRepo(dir, 'review')
    // Authoring-in-progress in draft/ (the atomic-publish source) must NOT be picked up…
    await mkdir(getAgentHandoffOutDraftRecipientDir(dir, 'review', 'builder'), { recursive: true })
    // …only a finalized parcel published into queued/ is.
    await mkdir(getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'integration'), {
      recursive: true,
    })
    expect(await readOutboxRecipients(dir, 'review')).toEqual(['integration'])
  })
})
