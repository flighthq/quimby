import type { SSHLocation } from '@quimbyhq/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const exec = vi.hoisted(() => vi.fn(async (_cmd: string) => ''))
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
  it('reports presence from the same invocation that removes it', async () => {
    exec.mockResolvedValue('REMOVED')
    expect(await removeRemoteWorkspace(location, 'abc')).toBe(true)
    const cmd = exec.mock.calls[0][0]
    expect(cmd).toContain('rm -rf')
    expect(cmd).toContain('.quimby/workspaces/')
  })

  it('reports false when the workspace was not there', async () => {
    exec.mockResolvedValue('ABSENT')
    expect(await removeRemoteWorkspace(location, 'abc')).toBe(false)
  })

  it('quotes the id so it cannot break out of the remove path', async () => {
    exec.mockResolvedValue('ABSENT')
    await removeRemoteWorkspace(location, 'a b; rm -rf /')
    expect(exec.mock.calls[0][0]).not.toMatch(/;\s*rm -rf \/(?!')/)
  })
})
