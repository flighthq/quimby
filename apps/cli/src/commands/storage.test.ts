import { beforeEach, describe, expect, it, vi } from 'vitest'

const listStorageWorkspaces = vi.hoisted(() => vi.fn())
const pruneStorageWorkspaces = vi.hoisted(() => vi.fn())
const pruneRemoteWorkspaces = vi.hoisted(() => vi.fn())
const removeStorageWorkspace = vi.hoisted(() => vi.fn())
const resolveWorkspace = vi.hoisted(() => vi.fn())
const loadState = vi.hoisted(() => vi.fn())
const listRemoteWorkspaces = vi.hoisted(() => vi.fn())
const removeRemoteWorkspace = vi.hoisted(() => vi.fn())

vi.mock('@quimbyhq/git', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  findRoot: vi.fn(async () => '/repo'),
  getRemoteUrl: vi.fn(async () => 'git@example.com:repo.git'),
}))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  listStorageWorkspaces,
  pruneStorageWorkspaces,
  pruneRemoteWorkspaces,
  removeStorageWorkspace,
  resolveWorkspace,
  loadState,
  listRemoteWorkspaces,
  removeRemoteWorkspace,
  loadQuimbyConfig: vi.fn(async () => ({ hosts: { remote: { type: 'ssh', host: 'user@box' } } })),
}))

import cmd, {
  runStorageListCommand,
  runStorageListRemoteCommand,
  runStoragePathCommand,
  runStoragePruneCommand,
  runStoragePruneRemoteCommand,
  runStorageRemoveCommand,
  runStorageRemoveRemoteCommand,
} from './storage'

beforeEach(() => {
  pruneRemoteWorkspaces.mockReset()
  loadState.mockReset()
  listRemoteWorkspaces.mockReset()
  removeRemoteWorkspace.mockReset()
  listStorageWorkspaces.mockReset()
})

describe('runStorageListCommand', () => {
  it('lists durable workspaces', async () => {
    listStorageWorkspaces.mockResolvedValueOnce([
      {
        id: 'proj-id',
        path: '/data/proj-id',
        registered: true,
        exists: true,
        repoRoot: '/repo',
        sourceRepo: 'git@example.com:repo.git',
      },
    ])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runStorageListCommand()

    expect(log).toHaveBeenCalledWith(expect.stringContaining('proj-id'))
    expect(log).toHaveBeenCalledWith('  repo: /repo')
    log.mockRestore()
  })
})

describe('runStorageListRemoteCommand', () => {
  it('labels the active lane, ones no local project claims, and a half-provisioned one', async () => {
    loadState.mockResolvedValue({ id: 'active-id' })
    listStorageWorkspaces.mockResolvedValue([{ id: 'active-id', registered: true }])
    listRemoteWorkspaces.mockResolvedValue([
      { id: 'active-id', agents: 4, sizeKb: 2048 },
      { id: 'orphan-id', agents: 2, sizeKb: 1024 },
      { id: 'halfdone-id', sizeKb: 4 },
    ])
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: string) => void lines.push(m))

    await runStorageListRemoteCommand({ args: { host: 'remote' } })
    spy.mockRestore()

    const out = lines.join('\n')
    expect(out).toContain('active-id  active')
    expect(out).toContain('orphan-id  unclaimed here')
    // The lane `prune-remote` cannot see must be visible and legible as such.
    expect(out).toContain('halfdone-id  unclaimed here, no agents dir')
  })
})

describe('runStoragePathCommand', () => {
  it('is wired as the storage command', () => {
    expect((cmd.meta as { name?: string })?.name).toBe('storage')
  })

  it('prints the durable path for the current workspace', async () => {
    resolveWorkspace.mockResolvedValueOnce({ state: { id: 'proj-id' }, repoRoot: '/repo' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runStoragePathCommand()

    expect(log).toHaveBeenCalledWith(expect.stringContaining('proj-id'))
    log.mockRestore()
  })
})

describe('runStoragePruneCommand', () => {
  it('previews prune unless forced', async () => {
    pruneStorageWorkspaces.mockResolvedValueOnce([{ id: 'old', path: '/data/old' }])

    await runStoragePruneCommand({ args: { force: false } })

    expect(pruneStorageWorkspaces).toHaveBeenCalledWith({ force: false })
  })
})

describe('runStoragePruneRemoteCommand', () => {
  it('prune-remote keeps the active workspace and previews unless forced', async () => {
    loadState.mockResolvedValueOnce({ id: 'active-id' })
    pruneRemoteWorkspaces.mockResolvedValueOnce([{ id: 'orphan', sourceRepo: 'x' }])

    await runStoragePruneRemoteCommand({ args: { host: 'remote', force: false } })

    expect(pruneRemoteWorkspaces).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'user@box', alias: 'remote' }),
      { sourceRepo: 'git@example.com:repo.git', keepId: 'active-id', force: false },
    )
  })

  it('prune-remote refuses when there is no local workspace to protect', async () => {
    loadState.mockRejectedValueOnce(new Error('no state'))

    await expect(
      runStoragePruneRemoteCommand({ args: { host: 'remote', force: true } }),
    ).rejects.toThrow(/adopt one first/)
    expect(pruneRemoteWorkspaces).not.toHaveBeenCalled()
  })
})

describe('runStorageRemoveCommand', () => {
  it('requires force for explicit removal', async () => {
    await expect(
      runStorageRemoveCommand({ args: { id: 'proj-id', force: false } }),
    ).rejects.toThrow(/--force/)
  })

  it('removes one workspace when forced', async () => {
    removeStorageWorkspace.mockResolvedValueOnce(true)

    await runStorageRemoveCommand({ args: { id: 'proj-id', force: true } })

    expect(removeStorageWorkspace).toHaveBeenCalledWith('proj-id')
  })
})

describe('runStorageRemoveRemoteCommand', () => {
  it('refuses without --force', async () => {
    await expect(
      runStorageRemoveRemoteCommand({ args: { id: 'x', host: 'remote' } }),
    ).rejects.toThrow(/--force/)
    expect(removeRemoteWorkspace).not.toHaveBeenCalled()
  })

  it('refuses to remove the workspace this repo is using, even with --force', async () => {
    // It holds this project's agent repos, mailboxes and assignments; none of it is recoverable.
    loadState.mockResolvedValue({ id: 'active-id' })
    listStorageWorkspaces.mockResolvedValue([])
    await expect(
      runStorageRemoveRemoteCommand({ args: { id: 'active-id', host: 'remote', force: true } }),
    ).rejects.toThrow(/refusing to remove it/)
    expect(removeRemoteWorkspace).not.toHaveBeenCalled()
  })

  it('removes a non-active workspace on the named host', async () => {
    loadState.mockResolvedValue({ id: 'active-id' })
    listStorageWorkspaces.mockResolvedValue([])
    removeRemoteWorkspace.mockResolvedValue(true)
    await runStorageRemoveRemoteCommand({ args: { id: 'other-id', host: 'remote', force: true } })
    expect(removeRemoteWorkspace).toHaveBeenCalledWith(expect.anything(), 'other-id')
  })
})
