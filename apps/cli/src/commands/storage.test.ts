import { beforeEach, describe, expect, it, vi } from 'vitest'

const listStorageWorkspaces = vi.hoisted(() => vi.fn())
const pruneStorageWorkspaces = vi.hoisted(() => vi.fn())
const pruneRemoteWorkspaces = vi.hoisted(() => vi.fn())
const removeStorageWorkspace = vi.hoisted(() => vi.fn())
const resolveWorkspace = vi.hoisted(() => vi.fn())
const loadState = vi.hoisted(() => vi.fn())

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
  loadQuimbyConfig: vi.fn(async () => ({ hosts: { remote: { type: 'ssh', host: 'user@box' } } })),
}))

import cmd, {
  runStorageListCommand,
  runStoragePathCommand,
  runStoragePruneCommand,
  runStoragePruneRemoteCommand,
  runStorageRemoveCommand,
} from './storage'

beforeEach(() => {
  pruneRemoteWorkspaces.mockReset()
  loadState.mockReset()
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
