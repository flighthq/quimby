import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentStatusMirrorDir } from '@quimbyhq/paths'
import type { AgentState } from '@quimbyhq/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const exec = vi.hoisted(() => vi.fn(async (_cmd: string) => ''))
vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getTransport: () => ({ exec }),
}))

import { deliverStatusSnapshot, deliverStatusSnapshots } from './statusDelivery'
import { formatStatusSnapshot } from './statusSnapshot'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quimby-statusdel-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('deliverStatusSnapshot', () => {
  it('writes the payload into a local recipient status/<from>.md mirror', async () => {
    const toAgent = { id: 'to-id', name: 'reviewer', location: { type: 'local' } } as AgentState
    const payload = formatStatusSnapshot('builder', 'halfway done', '2026-07-02T00:00:00.000Z')

    await deliverStatusSnapshot({
      repoRoot: dir,
      stateId: 'p',
      fromName: 'builder',
      toAgent,
      payload,
    })

    const written = await readFile(
      join(getAgentStatusMirrorDir(dir, 'to-id'), 'builder.md'),
      'utf-8',
    )
    expect(written).toBe(payload)
    expect(written).toContain('halfway done')
  })
})

describe('deliverStatusSnapshots', () => {
  const sshAgent = {
    id: 'r1',
    name: 'reviewer',
    location: { type: 'ssh', host: 'box', base: '~' },
  } as AgentState

  it('writes every peer into one remote call — the N² → N fix', async () => {
    exec.mockClear()
    await deliverStatusSnapshots({
      repoRoot: dir,
      stateId: 'proj',
      toAgent: sshAgent,
      snapshots: [
        { fromName: 'backend', payload: 'a' },
        { fromName: 'critic', payload: 'b' },
      ],
    })

    expect(exec).toHaveBeenCalledTimes(1)
    const cmd = exec.mock.calls[0][0]
    // The directory guarantee is kept, and in the SAME invocation as the writes — so there is no
    // window where it could vanish between the mkdir and the write.
    expect(cmd).toContain('mkdir -p')
    expect(cmd).toContain('backend.md')
    expect(cmd).toContain('critic.md')
  })

  it('survives status text that would break shell quoting', async () => {
    exec.mockClear()
    // A status file is arbitrary user prose; quoting it into a command is how you get a bug that
    // only fires for the one agent whose status contains a quote. base64 sidesteps it entirely.
    const nasty = `it's "quoted" $(rm -rf /) \`backticks\` \n`
    await deliverStatusSnapshots({
      repoRoot: dir,
      stateId: 'proj',
      toAgent: sshAgent,
      snapshots: [{ fromName: 'backend', payload: nasty }],
    })

    const cmd = exec.mock.calls[0][0]
    expect(cmd).not.toContain('rm -rf /')
    const encoded = /printf %s '([A-Za-z0-9+/=]+)'/.exec(cmd)
    expect(encoded).not.toBeNull()
    expect(Buffer.from(encoded![1], 'base64').toString('utf-8')).toBe(nasty)
  })

  it('does nothing when there is nothing to mirror', async () => {
    exec.mockClear()
    await deliverStatusSnapshots({
      repoRoot: dir,
      stateId: 'proj',
      toAgent: sshAgent,
      snapshots: [],
    })
    expect(exec).not.toHaveBeenCalled()
  })

  it('writes each peer file for a local agent', async () => {
    const local = { id: 'l1', name: 'builder' } as AgentState
    await deliverStatusSnapshots({
      repoRoot: dir,
      stateId: 'proj',
      toAgent: local,
      snapshots: [
        { fromName: 'backend', payload: formatStatusSnapshot('backend', 'x', 'now') },
        { fromName: 'critic', payload: formatStatusSnapshot('critic', 'y', 'now') },
      ],
    })

    const mirrorDir = getAgentStatusMirrorDir(dir, 'l1')
    expect(await readFile(join(mirrorDir, 'backend.md'), 'utf-8')).toContain('x')
    expect(await readFile(join(mirrorDir, 'critic.md'), 'utf-8')).toContain('y')
  })
})
