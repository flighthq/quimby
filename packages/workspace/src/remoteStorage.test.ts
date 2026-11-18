import type { SSHLocation } from '@quimbyhq/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const exec = vi.hoisted(() => vi.fn(async (_cmd: string, _opts?: { input?: string }) => ''))
vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: () => ({ exec }),
}))

import {
  getRemoteHostOverview,
  getRemoteWorkspaceLabel,
  parseRemoteHostOverview,
  parseRemoteWorkspaces,
  removeRemoteWorkspace,
  resolveRemoteWorkspaceId,
} from './remoteStorage'

const location = { type: 'ssh', host: 'box', base: '~' } as SSHLocation & { host: string }

afterEach(() => vi.clearAllMocks())

describe('getRemoteHostOverview', () => {
  it('asks for disk, workspaces and live sessions in ONE invocation', async () => {
    exec.mockResolvedValue(
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
        '/dev/x 1000 600 400 60% /\n' +
        'QBWS\taaaaaaaa-1\thttps://github.com/o/flight-rs-new.git\tmain\t3\t\n' +
        'QBLS\tqb-12345678\n',
    )
    const overview = await getRemoteHostOverview(location)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(overview.disk?.availKb).toBe(400)
    expect(overview.workspaces.map((w) => w.id)).toEqual(['aaaaaaaa-1'])
    expect([...overview.liveSessions]).toEqual(['qb-12345678'])
    // The listing in the overview is the fast one: no du walk.
    expect(exec.mock.calls[0][0]).not.toContain('du -sk')
  })
})

describe('getRemoteWorkspaceLabel', () => {
  it("names a workspace by its repository, whatever the remote's URL form", () => {
    expect(getRemoteWorkspaceLabel('https://github.com/flighthq/flight-rs-new')).toBe(
      'flight-rs-new',
    )
    expect(getRemoteWorkspaceLabel('git@github.com:flighthq/flight.git')).toBe('flight')
    expect(getRemoteWorkspaceLabel('/home/me/src/school/')).toBe('school')
    expect(getRemoteWorkspaceLabel(undefined)).toBeUndefined()
  })
})

describe('parseRemoteHostOverview', () => {
  it('reads each section by its own tag, ignoring noise', () => {
    const o = parseRemoteHostOverview('motd\nQBLS\tqb-a\nQBLS\t\nQBWS\tid1\t\t\t0\t\n')
    expect([...o.liveSessions]).toEqual(['qb-a'])
    expect(o.workspaces).toHaveLength(1)
    expect(o.disk).toBeNull()
  })
})

describe('parseRemoteWorkspaces', () => {
  it('ignores shell noise, since a login banner shares the stream with the rows', () => {
    const out = parseRemoteWorkspaces(
      'Welcome to box!\ndu: cannot read directory: Permission denied\nQBWS\taaa\t\t\t0\t8\n',
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ id: 'aaa', agents: 0, sizeKb: 8 })
  })

  it('keeps a provisioned-but-empty 0 distinct from a missing agents dir', () => {
    const [empty] = parseRemoteWorkspaces('QBWS\ta\t\t\t0\t1\n')
    const [missing] = parseRemoteWorkspaces('QBWS\tb\t\t\t-\t1\n')
    expect(empty.agents).toBe(0)
    expect(missing.agents).toBeUndefined()
  })

  it('sorts by id so repeated listings are diffable', () => {
    const out = parseRemoteWorkspaces('QBWS\tzz\t\t\t0\t1\nQBWS\taa\t\t\t0\t1\n')
    expect(out.map((w) => w.id)).toEqual(['aa', 'zz'])
  })
})

describe('removeRemoteWorkspace', () => {
  // Answers each of the calls a removal makes: the agent listing, the sandbox listing, the sandbox
  // removal (names on stdin), and finally the directory removal.
  function remoteHost(opts: {
    agents?: string[]
    sandboxes?: string[]
    dir?: 'REMOVED' | 'ABSENT'
  }) {
    exec.mockImplementation(async (cmd: string, o?: { input?: string }) => {
      if (cmd.startsWith('ls -1')) return (opts.agents ?? []).join('\n')
      if (o?.input !== undefined) {
        return o.input
          .trim()
          .split('\n')
          .map((l) => `QBSBXRM\t${l}\tok`)
          .join('\n')
      }
      if (cmd.includes('QBSBXCLI')) {
        return `QBSBXCLI\tsbx\n${(opts.sandboxes ?? []).map((n) => `QBSBX\tsbx\t${n}`).join('\n')}`
      }
      return opts.dir ?? 'REMOVED'
    })
  }

  it('reports presence from the same invocation that removes it', async () => {
    remoteHost({ dir: 'REMOVED' })
    expect((await removeRemoteWorkspace(location, 'abc')).removed).toBe(true)
    const cmd = exec.mock.calls.at(-1)![0]
    expect(cmd).toContain('rm -rf')
    expect(cmd).toContain('.quimby/workspaces/')
  })

  it('reports false when the workspace was not there', async () => {
    remoteHost({ dir: 'ABSENT' })
    expect((await removeRemoteWorkspace(location, 'abc')).removed).toBe(false)
  })

  it("removes its agents' sandboxes BEFORE the directory that names them, and no others", async () => {
    remoteHost({
      agents: ['aaaaaaaa-1111-2222-3333-444444444444'],
      sandboxes: ['qb-aaaaaaaa-0123456789ab', 'qb-bbbbbbbb-0123456789ab'],
    })
    const { sandboxes } = await removeRemoteWorkspace(location, 'abc')
    expect(sandboxes.removed.map((s) => s.name)).toEqual(['qb-aaaaaaaa-0123456789ab'])
    const calls = exec.mock.calls.map((c) => c[0] as string)
    const sweep = exec.mock.calls.findIndex((c) => (c[1] as { input?: string })?.input)
    const rmDir = calls.findIndex((c) => c.includes('printf REMOVED'))
    expect(sweep).toBeGreaterThan(-1)
    expect(sweep).toBeLessThan(rmDir)
  })

  it('quotes the id so it cannot break out of the remove path', async () => {
    remoteHost({ dir: 'ABSENT' })
    await removeRemoteWorkspace(location, 'a b; rm -rf /')
    for (const [cmd] of exec.mock.calls) expect(cmd).not.toMatch(/;\s*rm -rf \/(?!')/)
  })
})

describe('resolveRemoteWorkspaceId', () => {
  const ids = [
    'b20d2d32-7ba3-4eb9-af52-1',
    'b20d2d99-0000-0000-0000-1',
    '4611d72d-6367-41cb-8cd3-1',
  ]

  it('accepts a full id or a unique prefix', () => {
    expect(resolveRemoteWorkspaceId(ids, '4611d72d')).toEqual({ id: ids[2] })
    expect(resolveRemoteWorkspaceId(ids, ids[0])).toEqual({ id: ids[0] })
  })

  it('refuses a prefix that is ambiguous, unknown or too short rather than guessing', () => {
    expect(resolveRemoteWorkspaceId(ids, 'b20d2d')).toMatchObject({
      error: expect.stringContaining('too short'),
    })
    expect(resolveRemoteWorkspaceId([...ids, 'b20d2d32-x'], 'b20d2d32')).toMatchObject({
      error: expect.stringContaining('matches 2'),
    })
    expect(resolveRemoteWorkspaceId(ids, 'ffffffff')).toMatchObject({
      error: expect.stringContaining('No workspace'),
    })
  })
})
