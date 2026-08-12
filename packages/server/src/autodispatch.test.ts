import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAll, commit, init, tag } from '@quimbyhq/git'
import { getAgentDir, getAgentHandoffOutQueuedRecipientDir, getAgentRepoDir } from '@quimbyhq/paths'
import { collectingReporter, silentReporter } from '@quimbyhq/reporter'
import type { AgentAttestation, QuimbyState } from '@quimbyhq/types'
import { exists, readYaml } from '@quimbyhq/utils'
import { ensureWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  autoDispatchOutboxes,
  classifyOutboxDraft,
  createOutboxDispatchTracker,
  createWakeBundler,
  forgetOutboxAttempt,
} from './autodispatch'

const nudgeAgentSession = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@quimbyhq/session', () => ({ nudgeAgentSession }))

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
  await mkdir(join(agentDir, 'handoff', 'out', 'queued'), { recursive: true })
  await mkdir(join(agentDir, 'handoff', 'in', 'received'), { recursive: true })
  await mkdir(join(agentDir, 'status'), { recursive: true })
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
  return { id: 'proj', agents } as QuimbyState
}

async function stageDraft(senderId: string, recipient: string, note: string): Promise<void> {
  const draft = getAgentHandoffOutQueuedRecipientDir(dir, senderId, recipient)
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
    expect(await exists(getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder'))).toBe(true)

    await autoDispatchOutboxes(dir, state, tracker)
    // second cycle: mtime unchanged → settled → delivered + drained
    expect(await exists(getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder'))).toBe(false)
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
    expect(await exists(getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder'))).toBe(false)
    expect(events.some((e) => e.level === 'success' && /delivered/.test(e.message))).toBe(true)
    // §6a: an advisory parcel (no directs edge, not delegated) lands passively — no nudge.
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })

  it('nudges the recipient for a directed parcel along a directs edge (§6a)', async () => {
    await setupAgentRepo('review')
    await setupAgentRepo('builder')
    await stageDraft('review', 'builder', 'fix the null case')
    const tracker = createOutboxDispatchTracker()
    const state = stateWith('review', 'builder')
    state.agents.review.directs = ['builder'] // review directs builder → directed → interrupts

    await autoDispatchOutboxes(dir, state, tracker, silentReporter, 'directed', {
      wakeBundle: 0,
    })
    await autoDispatchOutboxes(dir, state, tracker, silentReporter, 'directed', {
      wakeBundle: 0,
    })

    const inbox = join(getAgentDir(dir, 'builder'), 'handoff', 'in', 'received')
    const [parcelName] = await readdir(inbox)
    expect(nudgeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'builder',
        courier: `delegated task ${parcelName} from review`,
      }),
    )
  })

  it('coalesces a cycle’s interrupting parcels into one nudge per recipient (§7a)', async () => {
    await setupAgentRepo('review')
    await setupAgentRepo('integration')
    await setupAgentRepo('builder')
    await stageDraft('review', 'builder', 'fix A')
    await stageDraft('integration', 'builder', 'fix B')
    const tracker = createOutboxDispatchTracker()
    const state = stateWith('review', 'integration', 'builder')
    state.agents.review.directs = ['builder']
    state.agents.integration.directs = ['builder']

    await autoDispatchOutboxes(dir, state, tracker, silentReporter, 'directed', {
      wakeBundle: 0,
    }) // settle cycle
    await autoDispatchOutboxes(dir, state, tracker, silentReporter, 'directed', {
      wakeBundle: 0,
    }) // deliver both → one coalesced wake

    expect(nudgeAgentSession).toHaveBeenCalledTimes(1)
    expect(nudgeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'builder',
        courier: expect.stringContaining('2 new parcels'),
      }),
    )
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

    const inbox = join(getAgentDir(dir, 'builder'), 'handoff', 'in', 'received')
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

    expect(await exists(getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'ghost'))).toBe(true)
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

    await rm(getAgentHandoffOutQueuedRecipientDir(dir, 'review', 'builder'), {
      recursive: true,
      force: true,
    })
    await autoDispatchOutboxes(dir, state, tracker)
    expect(tracker.seen.has('review/builder')).toBe(false)
  })

  it('does nothing when every outbox is empty', async () => {
    await setupAgentRepo('review')
    const { reporter, events } = collectingReporter()
    await autoDispatchOutboxes(dir, stateWith('review'), createOutboxDispatchTracker(), reporter)
    expect(events).toEqual([])
  })

  it('says why a delivered parcel woke nobody, so serve is never silently passive', async () => {
    await setupAgentRepo('review')
    await setupAgentRepo('builder')
    await stageDraft('builder', 'review', 'an ordinary advisory')
    const state = stateWith('review', 'builder')
    const tracker = createOutboxDispatchTracker()
    const { reporter, events } = collectingReporter()

    await autoDispatchOutboxes(dir, state, tracker, reporter)
    await autoDispatchOutboxes(dir, state, tracker, reporter)

    const said = events.map((e) => e.message).join('\n')
    expect(said).toContain('advisory')
    expect(said).toContain('review')
  })
})

describe('autoDispatchOutboxes bundling', () => {
  it('holds the wake inside the window, then sends one for the whole burst', async () => {
    await setupAgentRepo('review')
    await setupAgentRepo('builder')
    await stageDraft('review', 'builder', 'first')
    const tracker = createOutboxDispatchTracker()
    const state = stateWith('review', 'builder')
    state.agents.review.directs = ['builder']
    const bundler = createWakeBundler()
    const config = { wakeBundle: '12s' }

    await autoDispatchOutboxes(dir, state, tracker, silentReporter, 'directed', config, bundler, 0)
    await autoDispatchOutboxes(dir, state, tracker, silentReporter, 'directed', config, bundler, 10)
    // still inside the window — delivered, but deliberately not woken yet
    expect(nudgeAgentSession).not.toHaveBeenCalled()

    // past the window, measured from the FIRST parcel
    await autoDispatchOutboxes(
      dir,
      state,
      tracker,
      silentReporter,
      'directed',
      config,
      bundler,
      13_000,
    )
    expect(nudgeAgentSession).toHaveBeenCalledTimes(1)
    expect(bundler.pending.size).toBe(0)
  })

  it('reports a recipient whose wake is still bundled, so the sweep does not beat it to the punch', async () => {
    await setupAgentRepo('review')
    await setupAgentRepo('builder')
    await stageDraft('review', 'builder', 'first')
    const tracker = createOutboxDispatchTracker()
    const state = stateWith('review', 'builder')
    state.agents.review.directs = ['builder']
    const bundler = createWakeBundler()
    const config = { wakeBundle: '12s' }

    await autoDispatchOutboxes(dir, state, tracker, silentReporter, 'directed', config, bundler, 0)
    const nudged = await autoDispatchOutboxes(
      dir,
      state,
      tracker,
      silentReporter,
      'directed',
      config,
      bundler,
      10,
    )
    expect(nudgeAgentSession).not.toHaveBeenCalled()
    expect([...nudged]).toEqual(['builder'])
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

// The behaviour the window exists for: parcels arriving across CONSECUTIVE cycles cost one wake,
// not one per cycle. Only the wake waits — each parcel is delivered to the inbox on its own cycle.
describe('createOutboxDispatchTracker', () => {
  it('starts with empty maps', () => {
    const tracker = createOutboxDispatchTracker()
    expect(tracker.seen.size).toBe(0)
    expect(tracker.done.size).toBe(0)
  })
})

describe('createWakeBundler', () => {
  it('starts empty', () => {
    expect(createWakeBundler().pending.size).toBe(0)
  })

  it('measures the window from the FIRST parcel, so a trickle cannot defer it forever', () => {
    const bundler = createWakeBundler()
    const agent = { id: 'a', name: 'review' } as never
    bundler.pending.set('review', {
      agent,
      descriptors: ['parcel one'],
      senders: new Set(['foreman']),
      queuedAt: 1_000,
    })
    // a later parcel joins the existing entry and must NOT reset queuedAt
    const entry = bundler.pending.get('review')!
    entry.descriptors.push('parcel two')
    expect(entry.queuedAt).toBe(1_000)
  })
})

// A burst spread across consecutive poll cycles used to wake the recipient once per cycle, and each
// wake costs that agent a turn of context. The window holds the wake so the burst lands as one.
describe('forgetOutboxAttempt', () => {
  it('retries a failed carry on the next cycle instead of stranding it', async () => {
    // A transient failure must not be attempt-once: the draft is unchanged, so the very next cycle
    // has to try again or the work waits for a human.
    const tracker = createOutboxDispatchTracker()
    const key = 'builder/review'
    expect(classifyOutboxDraft(tracker, key, 100)).toBe('wait')
    expect(classifyOutboxDraft(tracker, key, 100)).toBe('dispatch')
    expect(classifyOutboxDraft(tracker, key, 100)).toBe('wait')

    forgetOutboxAttempt(tracker, key, 100)
    expect(classifyOutboxDraft(tracker, key, 100)).toBe('dispatch')
  })

  it('ignores an unknown mtime, so forgetting is never a no-op that silently loops', () => {
    const tracker = createOutboxDispatchTracker()
    classifyOutboxDraft(tracker, 'a/b', 1)
    classifyOutboxDraft(tracker, 'a/b', 1)
    forgetOutboxAttempt(tracker, 'a/b', undefined)
    expect(classifyOutboxDraft(tracker, 'a/b', 1)).toBe('wait')
  })
})
