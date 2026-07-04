import type { QuimbyConfig } from '@quimbyhq/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const exec = vi.hoisted(() => vi.fn())
const getSSHTransport = vi.hoisted(() => vi.fn(() => ({ exec })))
const ensureDurableWorkspace = vi.hoisted(() => vi.fn(async () => ({})))
const saveState = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport,
}))

vi.mock('@quimbyhq/git', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getCurrentRef: vi.fn(async () => 'host-head'),
}))

vi.mock('./storage', () => ({ ensureDurableWorkspace }))
vi.mock('./state', () => ({ saveState }))
vi.mock('execa', () => ({ execa: vi.fn(async () => ({ stdout: 'main' })) }))

import { adoptRemoteWorkspace, boundHostAliases, reconstructRemoteWorkspace } from './remoteAdopt'

const REMOTE_LOC = { type: 'ssh' as const, host: 'user@box', alias: 'remote' }

const config: QuimbyConfig = {
  hosts: {
    remote: { type: 'ssh', host: 'user@box' }, // bound
    placeholder: { type: 'ssh', host: 'placeholder' }, // self-referential → unbound
    bare: { type: 'ssh' }, // no address → unbound
  },
  roles: {
    review: { runtimeProfile: 'remote-claude', tmux: true },
    builder: { runtimeProfile: 'remote-codex', tmux: true },
  },
  presets: {
    remote: {
      agents: {
        review: { role: 'review', hostAlias: 'remote' },
        builder: { role: 'builder', hostAlias: 'remote' },
      },
    },
  },
}

beforeEach(() => {
  exec.mockReset()
  getSSHTransport.mockClear()
  ensureDurableWorkspace.mockClear()
  saveState.mockClear()
})

describe('adoptRemoteWorkspace', () => {
  it('returns null without scanning when no bound alias is declared', async () => {
    const result = await adoptRemoteWorkspace('/repo', { hosts: {} }, { sourceRepo: 'src' })
    expect(result).toBeNull()
    expect(getSSHTransport).not.toHaveBeenCalled()
  })

  it('returns null when no remote workspace matches this repo', async () => {
    exec.mockResolvedValueOnce('PROJECT\tother\tgit@x:other.git\tmain\n')
    const result = await adoptRemoteWorkspace('/repo', config, { sourceRepo: 'git@x:repo.git' })
    expect(result).toBeNull()
    expect(saveState).not.toHaveBeenCalled()
  })

  it('skips an unreachable alias instead of failing', async () => {
    exec.mockRejectedValueOnce(new Error('Connection refused'))
    const result = await adoptRemoteWorkspace('/repo', config, { sourceRepo: 'git@x:repo.git' })
    expect(result).toBeNull()
  })

  it('adopts the single remote workspace matching this repo', async () => {
    exec
      .mockResolvedValueOnce(
        'PROJECT\tproj-id\tgit@x:repo.git\tmain\nPROJECT\tother\tgit@x:other.git\tmain\n',
      )
      .mockResolvedValueOnce('AGENT\treview-id\treview\tseed-review\n')

    const state = await adoptRemoteWorkspace('/repo', config, { sourceRepo: 'git@x:repo.git' })

    expect(state?.id).toBe('proj-id')
    expect(saveState).toHaveBeenCalledWith('/repo', expect.objectContaining({ id: 'proj-id' }))
  })

  it('throws when several remote workspaces match, deferring the choice', async () => {
    exec.mockResolvedValueOnce(
      'PROJECT\ta\tgit@x:repo.git\tmain\nPROJECT\tb\tgit@x:repo.git\tmain\n',
    )
    await expect(
      adoptRemoteWorkspace('/repo', config, { sourceRepo: 'git@x:repo.git' }),
    ).rejects.toThrow(/Multiple remote quimby workspaces/)
  })
})

describe('boundHostAliases', () => {
  it('keeps bound aliases and drops unbound (placeholder / addressless) ones', () => {
    expect(boundHostAliases(config)).toEqual([
      { alias: 'remote', location: { type: 'ssh', host: 'user@box', alias: 'remote' } },
    ])
  })

  it('is empty when no hosts are declared', () => {
    expect(boundHostAliases({})).toEqual([])
  })
})

describe('reconstructRemoteWorkspace', () => {
  it('rebuilds agents from the remote scan, mapping roles', async () => {
    exec.mockResolvedValueOnce(
      'AGENT\treview-id\treview\tseed-review\nAGENT\tbuilder-id\tbuilder\tseed-builder\n',
    )

    await reconstructRemoteWorkspace(
      '/repo',
      REMOTE_LOC,
      config,
      { id: 'proj-id', sourceRepo: 'git@x:repo.git' },
      { presetName: 'remote', fallbackAlias: 'remote', sourceRepo: 'git@x:repo.git' },
    )

    expect(ensureDurableWorkspace).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ id: 'proj-id' }),
    )
    expect(saveState).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        id: 'proj-id',
        agents: expect.objectContaining({
          review: expect.objectContaining({
            id: 'review-id',
            seedCommit: 'seed-review',
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

  it('throws when the remote workspace has no agents', async () => {
    exec.mockResolvedValueOnce('')
    await expect(
      reconstructRemoteWorkspace(
        '/repo',
        REMOTE_LOC,
        config,
        { id: 'empty', sourceRepo: 'git@x:repo.git' },
        { presetName: 'remote', fallbackAlias: 'remote', sourceRepo: 'git@x:repo.git' },
      ),
    ).rejects.toThrow(/no recoverable agents/)
  })
})
