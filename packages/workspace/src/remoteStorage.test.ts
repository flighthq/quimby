import type { SSHLocation } from '@quimbyhq/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const exec = vi.hoisted(() => vi.fn(async (_cmd: string, _opts?: { input?: string }) => ''))
vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: () => ({ exec }),
}))

import { listRemoteWorkspaces, parseRemoteWorkspaces, removeRemoteWorkspace } from './remoteStorage'

const location = { type: 'ssh', host: 'box', base: '~' } as SSHLocation & { host: string }

afterEach(() => vi.clearAllMocks())

describe('listRemoteWorkspaces', () => {
  it('reports a half-provisioned lane that the adopt/prune scan skips entirely', async () => {
    // `prune-remote` requires `.quimby/agents` to exist, so a lane without it consumes disk while
    // being invisible to every other command — the exact residue a listing has to surface.
    exec.mockResolvedValue(
      'QBWS\taaa\thttps://github.com/o/r\tmain\t3\t2048\nQBWS\tbbb\t\t\t-\t4\n',
    )
    const out = await listRemoteWorkspaces(location)
    expect(out).toEqual([
      {
        id: 'aaa',
        sourceRepo: 'https://github.com/o/r',
        sourceRef: 'main',
        agents: 3,
        sizeKb: 2048,
      },
      { id: 'bbb', sizeKb: 4 },
    ])
    expect(out[1].agents).toBeUndefined()
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
