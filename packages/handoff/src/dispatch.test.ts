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
import { exists, readYaml } from '@quimbyhq/utils'
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

  it('carries the sender-attached files into the recipient inbox alongside the note', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    const draft = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder')
    await mkdir(draft, { recursive: true })
    await writeFile(join(draft, 'README.md'), 'see the brief')
    await writeFile(join(draft, 'brief.md'), '# Lighting rework brief')

    const results = await dispatchOutbox({
      state: stateWith('review', 'builder'),
      repoRoot: dir,
      sender: 'review',
    })

    expect(results[0]).toMatchObject({
      recipient: 'builder',
      status: 'delivered',
      files: ['brief.md'],
    })
    const received = getAgentHandoffInReceivedParcelDir(dir, 'builder', results[0].parcelName!)
    expect(await exists(join(received, 'brief.md'))).toBe(true)
    expect(await exists(join(received, 'README.md'))).toBe(true)
  })

  it('reports an attachment it cannot carry instead of dropping it silently', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    const draft = getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder')
    await mkdir(join(draft, 'notes'), { recursive: true })
    await writeFile(join(draft, 'README.md'), 'the note')
    // A name the assembler owns: carrying it would overwrite the parcel's own manifest.
    await writeFile(join(draft, 'meta.yaml'), 'from: someone-else')
    await writeFile(join(draft, 'brief.md'), 'carried fine')

    const [result] = await dispatchOutbox({
      state: stateWith('review', 'builder'),
      repoRoot: dir,
      sender: 'review',
    })

    expect(result.files).toEqual(['brief.md'])
    expect(result.skippedFiles).toEqual(['notes'])
  })

  it('promotes an agent delegation claim into host-stamped parcel metadata', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    await stageDraft(dir, 'review', 'builder', '---\ndelegated: true\n---\nreview the new API')

    const [result] = await dispatchOutbox({
      state: stateWith('review', 'builder'),
      repoRoot: dir,
      sender: 'review',
    })

    expect(result.userDirected).toBe(true)
    const meta = await readYaml<{ userDirected?: boolean }>(
      join(getAgentHandoffInReceivedParcelDir(dir, 'builder', result.parcelName!), 'meta.yaml'),
    )
    expect(meta.userDirected).toBe(true)
  })

  it('stamps userDirected + interrupts along a directs edge; advisory stays passive', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')

    // Plain advisory note, no edge → passive.
    await stageDraft(dir, 'review', 'builder', 'fix the null case')
    const [advisory] = await dispatchOutbox({
      state: stateWith('review', 'builder'),
      repoRoot: dir,
      sender: 'review',
    })
    expect(advisory.userDirected).toBeFalsy()
    expect(advisory.interrupts).toBeFalsy()

    // Same note, now with review → builder declared as a directs edge → directed (interrupts).
    await stageDraft(dir, 'review', 'builder', 'fix the null case')
    const directed = stateWith('review', 'builder')
    directed.agents.review.directs = ['builder']
    const [result] = await dispatchOutbox({ state: directed, repoRoot: dir, sender: 'review' })
    expect(result.userDirected).toBe(true)
    expect(result.interrupts).toBe(true)
  })

  it('honors an escalation only to the escalation target, else normalizes to advisory', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    await setupAgentRepo(dir, 'integration')
    const state = stateWith('review', 'builder', 'integration')
    state.agents.review.directs = ['builder'] // ⇒ builder's escalation target is review

    await stageDraft(dir, 'builder', 'review', '---\nescalate: true\n---\nblocked on X')
    await stageDraft(dir, 'builder', 'integration', '---\nescalate: true\n---\nfyi')
    const results = await dispatchOutbox({ state, repoRoot: dir, sender: 'builder' })

    const toReview = results.find((r) => r.recipient === 'review')!
    const toIntegration = results.find((r) => r.recipient === 'integration')!
    expect(toReview.escalation).toBe(true)
    expect(toReview.interrupts).toBe(true)
    // integration is not builder's escalation target → normalized to an ordinary advisory (passive).
    expect(toIntegration.escalation).toBeFalsy()
    expect(toIntegration.interrupts).toBeFalsy()
    // …and the refusal is reported, so a missing edge never reads as a silently quiet recipient.
    expect(toIntegration.downgraded).toBe('escalation')
    expect(toReview.downgraded).toBeUndefined()
  })

  it('wakes the recipient for ANY parcel when its nudge policy is `all` (unattended fleet)', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    const state = stateWith('review', 'builder')
    state.agents.review.nudge = 'all' // review takes every parcel as a wake, advisory included
    await stageDraft(dir, 'builder', 'review', 'plain advisory, no edge, no escalate')

    const [result] = await dispatchOutbox({ state, repoRoot: dir, sender: 'builder' })
    expect(result.interrupts).toBe(true)
    // it woke because of the policy, not because the graph made it directed
    expect(result.userDirected).toBeFalsy()
  })

  it('honors the legacy `always` spelling stored on an agent, not just the canonical `all`', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    const state = stateWith('review', 'builder')
    // What a pre-normalization `quimby sync` wrote from `nudge: always` in config.
    state.agents.review.nudge = 'always' as 'all'
    await stageDraft(dir, 'builder', 'review', 'upward advisory')

    const [result] = await dispatchOutbox({ state, repoRoot: dir, sender: 'builder' })
    expect(result.interrupts).toBe(true)
  })

  it('wakes for nothing when the recipient policy is `never`, even a directed parcel', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    const state = stateWith('review', 'builder')
    state.agents.review.directs = ['builder']
    state.agents.builder.nudge = 'never'
    await stageDraft(dir, 'review', 'builder', 'do the thing')

    const [result] = await dispatchOutbox({ state, repoRoot: dir, sender: 'review' })
    expect(result.interrupts).toBe(false)
  })

  it('takes the workspace default when the recipient declares no policy of its own', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    await stageDraft(dir, 'builder', 'review', 'plain advisory')

    const [result] = await dispatchOutbox({
      state: stateWith('review', 'builder'),
      repoRoot: dir,
      sender: 'builder',
      defaultNudge: 'all',
    })
    expect(result.interrupts).toBe(true)
  })

  it('flags an ordinary advisory as not downgraded — passive by design, not a refused interrupt', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    await stageDraft(dir, 'builder', 'review', 'just an fyi')

    const [result] = await dispatchOutbox({
      state: stateWith('review', 'builder'),
      repoRoot: dir,
      sender: 'builder',
    })
    expect(result.interrupts).toBeFalsy()
    expect(result.downgraded).toBeUndefined()
  })

  it('honors a reply-interrupt only when the replyTo parcel is in the replier’s inbox (§6c)', async () => {
    await setupAgentRepo(dir, 'review')
    await setupAgentRepo(dir, 'builder')
    // review really received a question parcel named "builder-q1".
    await mkdir(getAgentHandoffInReceivedParcelDir(dir, 'review', 'builder-q1'), {
      recursive: true,
    })

    await stageDraft(dir, 'review', 'builder', '---\nreply-to: builder-q1\n---\nhere is the answer')
    const [honored] = await dispatchOutbox({
      state: stateWith('review', 'builder'),
      repoRoot: dir,
      sender: 'review',
    })
    expect(honored.interrupts).toBe(true)

    // A reply to a parcel review never received → normalized to an ordinary advisory (passive).
    await stageDraft(dir, 'review', 'builder', '---\nreply-to: ghost-q9\n---\nspurious')
    const [spurious] = await dispatchOutbox({
      state: stateWith('review', 'builder'),
      repoRoot: dir,
      sender: 'review',
    })
    expect(spurious.interrupts).toBeFalsy()
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
