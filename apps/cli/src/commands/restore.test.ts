import { beforeEach, describe, expect, it, vi } from 'vitest'

const restoreWorkspaceLink = vi.hoisted(() => vi.fn())
const scanRemoteProjects = vi.hoisted(() => vi.fn())
const reconstructRemoteWorkspace = vi.hoisted(() => vi.fn(async () => ({ id: 'proj-id' })))

vi.mock('@quimbyhq/git', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  findRoot: vi.fn(async () => '/repo'),
  getRemoteUrl: vi.fn(async () => 'git@example.com:repo.git'),
}))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  restoreWorkspaceLink,
  scanRemoteProjects,
  reconstructRemoteWorkspace,
  loadQuimbyConfig: vi.fn(async () => ({
    hosts: {
      // Bound in (mock) private config, so restore's own scan connection resolves
      // to a concrete host without prompting.
      remote: { type: 'ssh', host: 'user@remote-box' },
    },
  })),
}))

import cmd, { runRestoreCommand } from './restore'

beforeEach(() => {
  restoreWorkspaceLink.mockReset()
  scanRemoteProjects.mockReset()
  reconstructRemoteWorkspace.mockReset()
  reconstructRemoteWorkspace.mockResolvedValue({ id: 'proj-id' })
})

describe('runRestoreCommand', () => {
  it('is a command', () => {
    expect((cmd.meta as { name?: string })?.name).toBe('restore')
  })

  it('restores from the local registry when a matching entry exists', async () => {
    restoreWorkspaceLink.mockResolvedValueOnce({ id: 'proj-id' })

    await runRestoreCommand({ args: {} })

    expect(restoreWorkspaceLink).toHaveBeenCalledWith('/repo', {
      id: undefined,
      sourceRepo: 'git@example.com:repo.git',
    })
    expect(scanRemoteProjects).not.toHaveBeenCalled()
  })

  it('errors without a host when the local registry has no match', async () => {
    restoreWorkspaceLink.mockResolvedValueOnce(null)

    await expect(runRestoreCommand({ args: {} })).rejects.toThrow(/quimby restore --host/)
    expect(scanRemoteProjects).not.toHaveBeenCalled()
  })

  it('reconstructs from the single remote workspace matching this repo', async () => {
    restoreWorkspaceLink.mockResolvedValueOnce(null)
    scanRemoteProjects.mockResolvedValueOnce([
      { id: 'proj-id', sourceRepo: 'git@example.com:repo.git', sourceRef: 'main' },
      { id: 'other-id', sourceRepo: 'git@example.com:other.git', sourceRef: 'main' },
    ])

    await runRestoreCommand({ args: { host: 'remote' } })

    expect(scanRemoteProjects).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'user@remote-box', alias: 'remote' }),
    )
    expect(reconstructRemoteWorkspace).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ host: 'user@remote-box' }),
      expect.any(Object),
      { id: 'proj-id', sourceRepo: 'git@example.com:repo.git', sourceRef: 'main' },
      { presetName: 'remote', fallbackAlias: 'remote', sourceRepo: 'git@example.com:repo.git' },
    )
  })

  it('throws when multiple remote workspaces match, asking for --id', async () => {
    restoreWorkspaceLink.mockResolvedValueOnce(null)
    scanRemoteProjects.mockResolvedValueOnce([
      { id: 'a', sourceRepo: 'git@example.com:repo.git' },
      { id: 'b', sourceRepo: 'git@example.com:repo.git' },
    ])

    await expect(runRestoreCommand({ args: { host: 'remote' } })).rejects.toThrow(/--id/)
    expect(reconstructRemoteWorkspace).not.toHaveBeenCalled()
  })

  it('selects a remote workspace by explicit --id', async () => {
    restoreWorkspaceLink.mockResolvedValueOnce(null)
    scanRemoteProjects.mockResolvedValueOnce([
      { id: 'a', sourceRepo: 'git@example.com:repo.git' },
      { id: 'b', sourceRepo: 'git@example.com:other.git' },
    ])

    await runRestoreCommand({ args: { host: 'remote', id: 'b' } })

    expect(reconstructRemoteWorkspace).toHaveBeenCalledWith(
      '/repo',
      expect.any(Object),
      expect.any(Object),
      { id: 'b', sourceRepo: 'git@example.com:other.git' },
      expect.objectContaining({ fallbackAlias: 'remote' }),
    )
  })
})
