import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentStatusMirrorDir } from '@quimbyhq/paths'
import type { AgentState } from '@quimbyhq/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const exec = vi.hoisted(() => vi.fn(async (_cmd: string, _opts?: { input?: string }) => ''))
vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getTransport: () => ({ exec }),
}))

import {
  deliverStatusSnapshot,
  deliverStatusSnapshots,
  renderRemoteStatusDelivery,
} from './statusDelivery'
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

  it('writes every peer in one remote call, with the payload on STDIN not the command line', async () => {
    exec.mockClear()
    await deliverStatusSnapshots({
      repoRoot: dir,
      stateId: 'proj',
      toAgent: sshAgent,
      snapshots: [
        { fromName: 'backend', payload: 'alpha-payload' },
        { fromName: 'critic', payload: 'beta-payload' },
      ],
    })

    expect(exec).toHaveBeenCalledTimes(1)
    const [cmd, opts] = exec.mock.calls[0]
    // The directory guarantee is kept, and in the SAME invocation as the writes — so there is no
    // window where it could vanish between the mkdir and the write.
    expect(cmd).toContain('mkdir -p')
    // The command must stay small and payload-free: execa echoes the whole command in its error
    // message, so anything embedded here lands in the server log on the first failed delivery.
    expect(cmd).not.toContain(Buffer.from('alpha-payload', 'utf-8').toString('base64'))
    expect(cmd.length).toBeLessThan(400)
    // …and the payloads arrive framed on stdin instead.
    const lines = opts!.input!.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0].split(' ')[0]).toBe('backend.md')
    expect(Buffer.from(lines[0].split(' ')[1], 'base64').toString('utf-8')).toBe('alpha-payload')
    expect(Buffer.from(lines[1].split(' ')[1], 'base64').toString('utf-8')).toBe('beta-payload')
  })

  it('keeps the command size flat as payloads grow — the log-flood regression', async () => {
    exec.mockClear()
    const huge = 'x'.repeat(50_000)
    await deliverStatusSnapshots({
      repoRoot: dir,
      stateId: 'proj',
      toAgent: sshAgent,
      snapshots: [{ fromName: 'backend', payload: huge }],
    })
    // A 50k status must not produce a 50k command; it goes to stdin.
    expect(exec.mock.calls[0][0].length).toBeLessThan(400)
    expect(exec.mock.calls[0][1]!.input!.length).toBeGreaterThan(50_000)
  })

  it('survives status text that would break shell quoting', async () => {
    exec.mockClear()
    // A status file is arbitrary user prose; quoting it into a command is how you get a bug that
    // only fires for the one agent whose status contains a quote. base64 on stdin sidesteps both
    // the quoting and the command-length problem.
    const nasty = `it's "quoted" $(rm -rf /) \`backticks\` \n`
    await deliverStatusSnapshots({
      repoRoot: dir,
      stateId: 'proj',
      toAgent: sshAgent,
      snapshots: [{ fromName: 'backend', payload: nasty }],
    })

    const [cmd, opts] = exec.mock.calls[0]
    expect(cmd).not.toContain('rm -rf /')
    const b64 = opts!.input!.trimEnd().split(' ')[1]
    expect(Buffer.from(b64, 'base64').toString('utf-8')).toBe(nasty)
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

// The nine-day bug. `sq()` quotes a path whole, so a leading `~/` never expands: the remote shell
// creates a directory literally named `~`, every write lands inside it, the command exits 0, and
// the server reports success while nothing reaches the agent. Verified against a real shell before
// the fix — the payload appeared at `$HOME/~/.quimby/...`.
describe('renderRemoteStatusDelivery', () => {
  const dir = '~/.quimby/workspaces/PID/.quimby/agents/AID/status'

  it('leaves the leading ~/ unquoted so the remote shell expands it', () => {
    const cmd = renderRemoteStatusDelivery(dir)
    expect(cmd).toContain("~/'.quimby/workspaces/PID/.quimby/agents/AID/status'")
    // the failure mode, stated as the thing that must never appear
    expect(cmd).not.toContain("'~/")
  })

  it('creates the directory and writes via a temp file in the same invocation', () => {
    const cmd = renderRemoteStatusDelivery(dir)
    expect(cmd.startsWith('mkdir -p ~/')).toBe(true)
    expect(cmd).toContain('.tmp')
    expect(cmd).toContain('mv ')
  })

  it('quotes an absolute base normally, since only ~ needs the exception', () => {
    expect(renderRemoteStatusDelivery('/srv/agents/a/status')).toContain("'/srv/agents/a/status'")
  })
})
