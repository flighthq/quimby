import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAll, commit, init, tag } from '@quimbyhq/git'
import { getAgentDir, getAgentOutboxDraftDir, getAgentRepoDir } from '@quimbyhq/paths'
import { collectingReporter } from '@quimbyhq/reporter'
import type { AgentAttestation, QuimbyState } from '@quimbyhq/types'
import { exists, readYaml } from '@quimbyhq/utils'
import { ensureWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  autoDispatchOutboxes,
  classifyOutboxDraft,
  createOutboxDispatchTracker,
} from './autodispatch'

vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: vi.fn(() => ({
    exec: vi.fn(async () => ''),
    writeFile: vi.fn(),
    ensureDir: vi.fn(),
  })),
}))

let dir: string

async function configureGit(cwd: string) {
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd })
}

async function setupAgentRepo(agentId: string): Promise<void> {
  const agentDir = getAgentDir(dir, agentId)
  await mkdir(join(agentDir, 'inbox', 'status'), { recursive: true })
  await mkdir(join(agentDir, 'outbox'), { recursive: true })
  const repoDir = getAgentRepoDir(dir, agentId)
  await mkdir(repoDir, { recursive: true })
  await init(repoDir)
  await configureGit(repoDir)
  await writeFile(join(repoDir, 'base.txt'), 'base\n')
  await addAll(repoDir)
  await commit(repoDir, 'base')
  await tag(repoDir, 'quimby/seed')
}

function stateWith(...names: string[]): QuimbyState {
  const agents: QuimbyState['agents'] = {}
  for (const name of names) {
    agents[name] = { id: name, name, location: { type: 'local' } } as QuimbyState['agents'][string]
  }
  return { id: 'proj', agents, subscriptions: {} } as QuimbyState
}

async function stageDraft(senderId: string, recipient: string, note: string): Promise<void> {
  const draft = getAgentOutboxDraftDir(dir, senderId, recipient)
  await mkdir(draft, { recursive: true })
  await writeFile(join(draft, 'README.md'), note)
}

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-autodispatch-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
  await execa('git', ['init'], { cwd: dir })
  await configureGit(dir)
  await writeFile(join(dir, 'README.md'), '# test')
  await execa('git', ['add', '-A'], { cwd: dir })
  await execa('git', ['commit', '-m', 'initial'], { cwd: dir })
  await ensureWorkspace(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('autoDispatchOutboxes', () => {
  it('waits one cycle (settle debounce) before delivering a draft', async () => {
    await setupAgentRepo('review')
    await setupAgentRepo('builder')
    await stageDraft('review', 'builder', 'fix Y')
    const tracker = createOutboxDispatchTracker()
    const state = stateWith('review', 'builder')

    await autoDispatchOutboxes(dir, state, tracker)
    // first cycle: unsettled, nothing delivered
    expect(await exists(getAgentOutboxDraftDir(dir, 'review', 'builder'))).toBe(true)

    await autoDispatchOutboxes(dir, state, tracker)
    // second cycle: mtime unchanged → settled → delivered + drained
    expect(await exists(getAgentOutboxDraftDir(dir, 'review', 'builder'))).toBe(false)
  })

  it('delivers the settled parcel and reports it', async () => {
    await setupAgentRepo('review')
    await setupAgentRepo('builder')
    await stageDraft('review', 'builder', 'please review')
    const tracker = createOutboxDispatchTracker()
    const state = stateWith('review', 'builder')

    await autoDispatchOutboxes(dir, state, tracker)
    const { reporter, events } = collectingReporter()
    await autoDispatchOutboxes(dir, state, tracker, reporter)

    // drained from the outbox = it was carried to the recipient
    expect(await exists(getAgentOutboxDraftDir(dir, 'review', 'builder'))).toBe(false)
    expect(events.some((e) => e.level === 'success' && /delivered/.test(e.message))).toBe(true)
  })

  it('embeds the sender attestation in the auto-dispatched parcel meta', async () => {
    await setupAgentRepo('review')
    await setupAgentRepo('builder')
    await writeFile(
      join(getAgentDir(dir, 'review'), 'status.md'),
      '```quimby-attest\ncommand: npm run ci\nresult: pass\n```',
    )
    await stageDraft('review', 'builder', 'please review')
    const tracker = createOutboxDispatchTracker()
    const state = stateWith('review', 'builder')

    await autoDispatchOutboxes(dir, state, tracker) // settle
    await autoDispatchOutboxes(dir, state, tracker) // deliver

    const inbox = join(getAgentDir(dir, 'builder'), 'inbox')
    const parcels = (await readdir(inbox)).filter((n) => n.startsWith('review-'))
    expect(parcels).toHaveLength(1)
    const meta = (await readYaml(join(inbox, parcels[0], 'meta.yaml'))) as {
      attestation?: AgentAttestation
    }
    expect(meta.attestation).toEqual({ command: 'npm run ci', result: 'pass' })
  })

  it('bounces an unknown recipient with a warning, leaving the draft in place', async () => {
    await setupAgentRepo('review')
    await stageDraft('review', 'ghost', 'hi')
    const tracker = createOutboxDispatchTracker()
    const state = stateWith('review')

    await autoDispatchOutboxes(dir, state, tracker)
    const { reporter, events } = collectingReporter()
    await autoDispatchOutboxes(dir, state, tracker, reporter)

    expect(await exists(getAgentOutboxDraftDir(dir, 'review', 'ghost'))).toBe(true)
    expect(events.some((e) => e.level === 'warn' && /not an agent/.test(e.message))).toBe(true)
  })

  it('prunes the tracker entry when a draft vanishes before it settles', async () => {
    await setupAgentRepo('review')
    await setupAgentRepo('builder')
    await stageDraft('review', 'builder', 'x')
    const tracker = createOutboxDispatchTracker()
    const state = stateWith('review', 'builder')

    await autoDispatchOutboxes(dir, state, tracker)
    expect(tracker.seen.has('review/builder')).toBe(true)

    await rm(getAgentOutboxDraftDir(dir, 'review', 'builder'), { recursive: true, force: true })
    await autoDispatchOutboxes(dir, state, tracker)
    expect(tracker.seen.has('review/builder')).toBe(false)
  })

  it('does nothing when every outbox is empty', async () => {
    await setupAgentRepo('review')
    const { reporter, events } = collectingReporter()
    await autoDispatchOutboxes(dir, stateWith('review'), createOutboxDispatchTracker(), reporter)
    expect(events).toEqual([])
  })
})

describe('classifyOutboxDraft', () => {
  it('waits on the first sighting (could still be mid-write)', () => {
    const tracker = createOutboxDispatchTracker()
    expect(classifyOutboxDraft(tracker, 'review/builder', 100)).toBe('wait')
  })

  it('dispatches once the mtime is unchanged across a cycle, then never again', () => {
    const tracker = createOutboxDispatchTracker()
    expect(classifyOutboxDraft(tracker, 'review/builder', 100)).toBe('wait')
    expect(classifyOutboxDraft(tracker, 'review/builder', 100)).toBe('dispatch')
    expect(classifyOutboxDraft(tracker, 'review/builder', 100)).toBe('wait')
  })

  it('resets to waiting when the draft changes (still being authored)', () => {
    const tracker = createOutboxDispatchTracker()
    classifyOutboxDraft(tracker, 'review/builder', 100)
    expect(classifyOutboxDraft(tracker, 'review/builder', 200)).toBe('wait')
    expect(classifyOutboxDraft(tracker, 'review/builder', 200)).toBe('dispatch')
  })

  it('re-dispatches a recipient re-authored at a new mtime after delivery', () => {
    const tracker = createOutboxDispatchTracker()
    classifyOutboxDraft(tracker, 'review/builder', 100)
    expect(classifyOutboxDraft(tracker, 'review/builder', 100)).toBe('dispatch')
    classifyOutboxDraft(tracker, 'review/builder', 300)
    expect(classifyOutboxDraft(tracker, 'review/builder', 300)).toBe('dispatch')
  })

  it('tracks independent sender/recipient pairs separately', () => {
    const tracker = createOutboxDispatchTracker()
    classifyOutboxDraft(tracker, 'review/builder', 100)
    classifyOutboxDraft(tracker, 'review/integration', 200)
    expect(classifyOutboxDraft(tracker, 'review/builder', 100)).toBe('dispatch')
    expect(classifyOutboxDraft(tracker, 'review/integration', 200)).toBe('dispatch')
  })
})

describe('createOutboxDispatchTracker', () => {
  it('starts with empty maps', () => {
    const tracker = createOutboxDispatchTracker()
    expect(tracker.seen.size).toBe(0)
    expect(tracker.done.size).toBe(0)
  })
})
