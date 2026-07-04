import { describe, expect, it, vi } from 'vitest'

const restoreWorkspaceLink = vi.hoisted(() => vi.fn())
const ensureDurableWorkspace = vi.hoisted(() => vi.fn(async () => {}))
const saveState = vi.hoisted(() => vi.fn(async () => {}))
const exec = vi.hoisted(() => vi.fn())
const getSSHTransport = vi.hoisted(() => vi.fn(() => ({ exec })))

vi.mock('@quimbyhq/git', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  findRoot: vi.fn(async () => '/repo'),
  getRemoteUrl: vi.fn(async () => 'git@example.com:repo.git'),
  getCurrentRef: vi.fn(async () => 'host-head'),
}))

vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport,
}))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  ensureDurableWorkspace,
  restoreWorkspaceLink,
  saveState,
  loadQuimbyConfig: vi.fn(async () => ({
    hosts: {
      // Bound in (mock) private config, so restore's own scan connection resolves
      // to a concrete host without prompting.
      remote: { type: 'ssh', host: 'user@remote-box' },
    },
    roles: {
      review: { runtimeProfile: 'remote-claude', tmux: true },
      builder: { runtimeProfile: 'remote-codex', tmux: true },
    },
    recipes: {
      remote: {
        agents: {
          review: { role: 'review', hostAlias: 'remote' },
          builder: { role: 'builder', hostAlias: 'remote' },
        },
        subscriptions: {
          review: ['builder'],
        },
      },
    },
  })),
}))

vi.mock('execa', () => ({ execa: vi.fn(async () => ({ stdout: 'main' })) }))

import cmd, { runRestoreCommand } from './restore'

describe('restore', () => {
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
    expect(getSSHTransport).not.toHaveBeenCalled()
  })

  it('reconstructs state from a remote workspace when local registry is missing', async () => {
    restoreWorkspaceLink.mockResolvedValueOnce(null)
    exec
      .mockResolvedValueOnce('PROJECT\tproj-id\tgit@example.com:repo.git\tmain\n')
      .mockResolvedValueOnce(
        'AGENT\treview-id\treview\tseed-review\nAGENT\tbuilder-id\tbuilder\tseed-builder\n',
      )

    await runRestoreCommand({ args: { host: 'remote' } })

    expect(exec.mock.calls[1][0]).toContain('root=$HOME/')
    expect(ensureDurableWorkspace).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ id: 'proj-id' }),
    )
    expect(saveState).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        id: 'proj-id',
        subscriptions: { review: ['builder'] },
        agents: expect.objectContaining({
          review: expect.objectContaining({
            id: 'review-id',
            seedCommit: 'seed-review',
            // Recovered agents store the alias reference; the address resolves at launch.
            location: { type: 'ssh', alias: 'remote' },
            defaults: { runtimeProfile: 'remote-claude' },
            tmux: true,
          }),
          builder: expect.objectContaining({
            id: 'builder-id',
            seedCommit: 'seed-builder',
            defaults: { runtimeProfile: 'remote-codex' },
          }),
        }),
      }),
    )
  })
})
