import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAll, commit, init, tag } from '@quimbyhq/git'
import {
  getAgentDir,
  getAgentHandoffInReceivedParcelDir,
  getAgentHandoffOutQueuedRecipientDir,
  getAgentHandoffOutSentRecipientDir,
  getAgentRepoDir,
} from '@quimbyhq/paths'
import type { QuimbyState } from '@quimbyhq/types'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dispatchOutbox, dispatchOutboxes } from './dispatch'

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
  const repoRoot = join(tmpdir(), `quimby-dispatch-${crypto.randomUUID()}`)
  await mkdir(repoRoot, { recursive: true })
  await execa('git', ['init'], { cwd: repoRoot })
  await configureGit(repoRoot)
  await writeFile(join(repoRoot, 'README.md'), '# Project')
  await execa('git', ['add', '-A'], { cwd: repoRoot })
  await execa('git', ['commit', '-m', 'initial'], { cwd: repoRoot })
  await ensureWorkspace(repoRoot)
  return repoRoot
}

async function setupAgentRepo(repoRoot: string, agentId: string): Promise<void> {
  const agentRepoDir = getAgentRepoDir(repoRoot, agentId)
  const agentDir = getAgentDir(repoRoot, agentId)
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
}

function stateWith(...names: string[]): QuimbyState {
  const agents: QuimbyState['agents'] = {}
  for (const name of names) {
    agents[name] = { id: name, name, location: { type: 'local' } } as QuimbyState['agents'][string]
  }
  return { id: 'proj', agents } as QuimbyState
}

async function stageDraft(repoRoot: string, senderId: string, recipient: string, note: string) {
  const draft = getAgentHandoffOutQueuedRecipientDir(repoRoot, senderId, recipient)
  await mkdir(draft, { recursive: true })
  await writeFile(join(draft, 'README.md'), note)
}

beforeEach(async () => {
  dir = await setupRepoRoot()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('dispatchOutbox', () => {
  it('returns [] when the sender is unknown', async () => {
    expect(await dispatchOutbox({ state: stateWith(), repoRoot: dir, sender: 'ghost' })).toEqual([])
  })

  it('bounces an unknown recipient (left in the outbox)', async () => {
    await setupAgentRepo(dir, 'review')
    await stageDraft(dir, 'review', 'ghost', 'fix Y')
    const results = await dispatchOutbox({
      state: stateWith('review'),
      repoRoot: dir,
      sender: 'review',
    })
    expect(results).toEqual([{ recipient: 'ghost', status: 'unknown' }])
    expect(await exists(getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'ghost'))).toBe(true)
  })

  it('delivers a note-only draft, drains it to .sent, and lands it in the inbox', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    await stageDraft(dir, 'review', 'builder', 'fix the null case')

    const results = await dispatchOutbox({
      state: stateWith('review', 'builder'),
      repoRoot: dir,
      sender: 'review',
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ recipient: 'builder', status: 'delivered', hasNote: true })
    const parcelName = results[0].parcelName!
    expect(await exists(getAgentHandoffInReceivedParcelDir(dir, 'builder', parcelName))).toBe(true)
    expect(await exists(getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder'))).toBe(false)
    expect(await exists(getAgentHandoffOutSentRecipientDir(dir, 'review', 'builder'))).toBe(true)
  })

  it('fails when attach references a nonexistent code source', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    const draft = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder')
    await mkdir(draft, { recursive: true })
    await writeFile(join(draft, 'README.md'), '---\nattach: phantom\n---\nuse their code')

    const results = await dispatchOutbox({
      state: stateWith('review', 'builder'),
      repoRoot: dir,
      sender: 'review',
    })

    expect(results).toEqual([
      { recipient: 'builder', status: 'failed', error: 'code source "phantom" not found' },
    ])
  })

  it('runs beforeStage on the code source before staging', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    await stageDraft(dir, 'review', 'builder', 'fix it')
    const seen: string[] = []

    await dispatchOutbox({
      state: stateWith('review', 'builder'),
      repoRoot: dir,
      sender: 'review',
      beforeStage: async (name) => {
        seen.push(name)
      },
    })

    expect(seen).toEqual(['review'])
  })

  it('only dispatches the recipients it is given', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    await setupAgentRepo(dir, 'integration')
    await stageDraft(dir, 'review', 'builder', 'a')
    await stageDraft(dir, 'review', 'integration', 'b')

    const results = await dispatchOutbox({
      state: stateWith('review', 'builder', 'integration'),
      repoRoot: dir,
      sender: 'review',
      recipients: ['builder'],
    })

    expect(results.map((r) => r.recipient)).toEqual(['builder'])
    expect(await exists(getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'integration'))).toBe(
      true,
    )
  })

  it('delivers multiple recipients in one pass', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    await setupAgentRepo(dir, 'integration')
    await stageDraft(dir, 'review', 'builder', 'fix A')
    await stageDraft(dir, 'review', 'integration', 'promote B')

    const results = await dispatchOutbox({
      state: stateWith('review', 'builder', 'integration'),
      repoRoot: dir,
      sender: 'review',
    })

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === 'delivered')).toBe(true)
  })
})

describe('dispatchOutboxes', () => {
  it('throws when neither an agent nor --all is given', async () => {
    await expect(
      dispatchOutboxes({ state: stateWith('review'), repoRoot: dir, all: false }),
    ).rejects.toThrow(/Specify an agent/)
  })

  it('throws when the named agent does not exist', async () => {
    await expect(
      dispatchOutboxes({ state: stateWith('review'), repoRoot: dir, agent: 'ghost', all: false }),
    ).rejects.toThrow(/not found/)
  })

  it('reports totalQueued 0 and no senders when the outbox is empty', async () => {
    await setupAgentRepo(dir, 'review')
    const result = await dispatchOutboxes({
      state: stateWith('review'),
      repoRoot: dir,
      agent: 'review',
      all: false,
    })
    expect(result).toEqual({ senders: [], totalQueued: 0 })
  })

  it('dispatches a single named agent and counts the queued parcels', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    await stageDraft(dir, 'review', 'builder', 'fix it')

    const result = await dispatchOutboxes({
      state: stateWith('review', 'builder'),
      repoRoot: dir,
      agent: 'review',
      all: false,
    })

    expect(result.totalQueued).toBe(1)
    expect(result.senders).toHaveLength(1)
    expect(result.senders[0].sender).toBe('review')
    expect(result.senders[0].results[0]).toMatchObject({
      recipient: 'builder',
      status: 'delivered',
    })
  })

  it('with --all, sweeps every sender and omits agents whose outbox is empty', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    await setupAgentRepo(dir, 'idle')
    await stageDraft(dir, 'review', 'builder', 'fix it')

    const result = await dispatchOutboxes({
      state: stateWith('review', 'builder', 'idle'),
      repoRoot: dir,
      all: true,
    })

    expect(result.totalQueued).toBe(1)
    expect(result.senders.map((s) => s.sender)).toEqual(['review'])
  })
})
