import { describe, expect, it, vi } from 'vitest'

const listStorageWorkspaces = vi.hoisted(() => vi.fn())
const pruneStorageWorkspaces = vi.hoisted(() => vi.fn())
const removeStorageWorkspace = vi.hoisted(() => vi.fn())
const resolveWorkspace = vi.hoisted(() => vi.fn())

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  listStorageWorkspaces,
  pruneStorageWorkspaces,
  removeStorageWorkspace,
  resolveWorkspace,
}))

import cmd, {
  runStorageListCommand,
  runStoragePathCommand,
  runStoragePruneCommand,
  runStorageRemoveCommand,
} from './storage'

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
