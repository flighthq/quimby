import { logger } from '@quimbyhq/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listStorageWorkspaces = vi.hoisted(() => vi.fn())
const pruneStorageWorkspaces = vi.hoisted(() => vi.fn())
const removeStorageWorkspace = vi.hoisted(() => vi.fn())
const resolveWorkspace = vi.hoisted(() => vi.fn())
const loadState = vi.hoisted(() => vi.fn())
const listRemoteWorkspaces = vi.hoisted(() => vi.fn())
const removeRemoteWorkspace = vi.hoisted(() => vi.fn())
const scanRemoteWorkspaceUsage = vi.hoisted(() => vi.fn())
const listRemoteLiveSessions = vi.hoisted(() => vi.fn(async () => new Set<string>()))
const getRemoteDiskUsage = vi.hoisted(() => vi.fn(async () => null))
const listQuimbySandboxes = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({
    clis: [] as string[],
    sandboxes: [] as { cli: string; name: string }[],
  })),
)
const removeQuimbySandboxes = vi.hoisted(() =>
  vi.fn(async (_run: unknown, list: { cli: string; name: string }[]) => ({
    removed: list,
    failed: [],
  })),
)
const listRemoteAgentIds = vi.hoisted(() => vi.fn(async () => new Set<string>()))
vi.mock('@quimbyhq/runtimes', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  listQuimbySandboxes,
  removeQuimbySandboxes,
}))
const removeRemoteReclaimableDirs = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({ removed: ['target'], live: false })),
)

vi.mock('@quimbyhq/git', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  findRoot: vi.fn(async () => '/repo'),
  getRemoteUrl: vi.fn(async () => 'git@example.com:repo.git'),
}))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  listStorageWorkspaces,
  pruneStorageWorkspaces,
  removeStorageWorkspace,
  resolveWorkspace,
  loadState,
  // The host listing now arrives with disk and live sessions in one round trip; tests keep setting
  // the workspaces and sessions through the two mocks below.
  getRemoteHostOverview: vi.fn(async () => ({
    disk: null,
    workspaces: (await listRemoteWorkspaces()) ?? [],
    liveSessions: await listRemoteLiveSessions(),
  })),
  removeRemoteWorkspace,
  scanRemoteWorkspaceUsage,
  listRemoteLiveSessions,
  getRemoteDiskUsage,
  removeRemoteReclaimableDirs,
  listRemoteAgentIds,
  remoteSandboxShellRunner: () => async () => '',
  loadQuimbyConfig: vi.fn(async () => ({ hosts: { remote: { type: 'ssh', host: 'user@box' } } })),
}))

import cmd, {
  runStorageCleanRemoteCommand,
  runStorageListCommand,
  runStorageListRemoteCommand,
  runStoragePathCommand,
  runStoragePruneCommand,
  runStoragePruneRemoteCommand,
  runStorageRemoveCommand,
  runStorageRemoveRemoteCommand,
} from './storage'

beforeEach(() => {
  loadState.mockReset()
  listRemoteWorkspaces.mockReset()
  removeRemoteWorkspace.mockReset()
  listStorageWorkspaces.mockReset()
  listStorageWorkspaces.mockResolvedValue([])
  scanRemoteWorkspaceUsage.mockReset()
  scanRemoteWorkspaceUsage.mockImplementation(async (_loc: unknown, id: string) => quietUsage(id))
  removeRemoteReclaimableDirs.mockClear()
  removeQuimbySandboxes.mockClear()
  listQuimbySandboxes.mockResolvedValue({ clis: [], sandboxes: [] })
  removeRemoteWorkspace.mockResolvedValue({ removed: true, sandboxes: NO_SANDBOXES })
})

const NO_SANDBOXES = { clis: [], removed: [], failed: [] }

// Idle long enough to clear clean-remote's default --min-idle 1h.
const RECENT = Date.now() - 2 * 86_400_000

function agent(extra: Record<string, unknown> = {}) {
  return {
    id: 'abcdef1234',
    live: false,
    lastActiveAt: RECENT,
    commitsSinceSeed: 0,
    dirtyFiles: 0,
    reclaimable: [] as { path: string; sizeKb: number }[],
    ...extra,
  }
}

function quietUsage(id: string, extra: Record<string, unknown> = {}) {
  return { id, present: true, agents: [agent(extra)] }
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const push = (...a: unknown[]) => void lines.push(a.join(' '))
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(push),
    ...(['info', 'warn', 'success', 'error'] as const).map((m) =>
      vi.spyOn(logger, m).mockImplementation(push),
    ),
  ]
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) }
}

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
      { id: 'active-id', agents: 4 },
      { id: 'orphan-id', agents: 2 },
      { id: 'halfdone-id' },
    ])
    const { lines, restore } = captureLogs()
    await runStorageListRemoteCommand({ args: { host: 'remote' } })
    restore()

    const out = lines.join('\n')
    expect(out).toContain('(no origin) [active-i]  active')
    expect(out).toContain('(no origin) [orphan-i]  unclaimed here')
    // The lane `prune-remote` cannot see must be visible and legible as such.
    expect(out).toContain('(no origin) [halfdone]  unclaimed here, no agents dir')
  })

  it('lists fast (no du) and then measures each workspace, splitting out build output', async () => {
    loadState.mockResolvedValue({ id: 'active-id' })
    listRemoteWorkspaces.mockResolvedValue([{ id: 'w1', agents: 1 }])
    scanRemoteWorkspaceUsage.mockResolvedValue({
      id: 'w1',
      present: true,
      sizeKb: 10 * 1024 * 1024,
      agents: [agent({ reclaimable: [{ path: 'target', sizeKb: 9 * 1024 * 1024 }] })],
    })
    const { lines, restore } = captureLogs()
    await runStorageListRemoteCommand({ args: { host: 'remote' } })
    restore()

    expect(scanRemoteWorkspaceUsage).toHaveBeenCalledWith(
      expect.anything(),
      'w1',
      expect.objectContaining({ sizes: true }),
    )
    const out = lines.join('\n')
    expect(out).toContain('10.0G (9.0G build output)')
    expect(out).toContain('clean-remote --host remote')
  })

  it('prints each workspace as soon as it is measured, not behind a slower one', async () => {
    loadState.mockResolvedValue({ id: 'active-id' })
    listRemoteWorkspaces.mockResolvedValue([
      { id: 'slow0000', sourceRepo: 'https://x/slow' },
      { id: 'fast0000', sourceRepo: 'https://x/fast' },
    ])
    scanRemoteWorkspaceUsage.mockImplementation(async (_loc: unknown, id: string) => {
      await new Promise((r) => setTimeout(r, id.startsWith('slow') ? 40 : 1))
      return quietUsage(id)
    })
    const { lines, restore } = captureLogs()
    await runStorageListRemoteCommand({ args: { host: 'remote', size: false } })
    restore()
    const out = lines.join('\n')
    expect(out.indexOf('fast [fast0000]')).toBeLessThan(out.indexOf('slow [slow0000]'))
  })

  it('says which workspaces it is still measuring when it has been quiet a while', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      loadState.mockResolvedValue({ id: 'active-id' })
      listRemoteWorkspaces.mockResolvedValue([
        { id: 'huge0000', sourceRepo: 'https://x/flight-rs-new' },
      ])
      let finish: (v: unknown) => void = () => {}
      scanRemoteWorkspaceUsage.mockImplementation(
        () => new Promise((resolve) => (finish = () => resolve(quietUsage('huge0000')))),
      )
      const { lines, restore } = captureLogs()
      const run = runStorageListRemoteCommand({ args: { host: 'remote' } })
      await vi.waitFor(() => expect(scanRemoteWorkspaceUsage).toHaveBeenCalled())
      vi.advanceTimersByTime(20_000)
      finish(undefined)
      await run
      restore()
      expect(lines.join('\n')).toContain('…still measuring flight-rs-new [huge0000] (0 of 1 done)')
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a claimed workspace whose local checkout is gone, and hints at dormant ones', async () => {
    loadState.mockResolvedValue({ id: 'active-id' })
    listStorageWorkspaces.mockResolvedValue([
      { id: 'temp', registered: true, repoRoot: '/definitely/not/here' },
    ])
    listRemoteWorkspaces.mockResolvedValue([{ id: 'temp', agents: 1 }])
    scanRemoteWorkspaceUsage.mockResolvedValue(
      quietUsage('temp', { lastActiveAt: Date.now() - 90 * 86_400_000 }),
    )
    const { lines, restore } = captureLogs()
    await runStorageListRemoteCommand({ args: { host: 'remote', size: false } })
    restore()

    const out = lines.join('\n')
    expect(out).toContain('[temp]  claimed, project gone')
    expect(out).toContain('last active: 90d ago')
    expect(out).toContain('prune-remote --host remote --idle 30d')
  })
})

describe('runStorageCleanRemoteCommand', () => {
  beforeEach(() => {
    loadState.mockResolvedValue({ id: 'active-id' })
    listRemoteWorkspaces.mockResolvedValue([{ id: 'w1', agents: 2 }])
  })

  it('previews without deleting', async () => {
    scanRemoteWorkspaceUsage.mockResolvedValue({
      id: 'w1',
      present: true,
      agents: [agent({ reclaimable: [{ path: 'target', sizeKb: 2048 }] })],
    })
    const { lines, restore } = captureLogs()
    await runStorageCleanRemoteCommand({ args: { host: 'remote' } })
    restore()

    expect(removeRemoteReclaimableDirs).not.toHaveBeenCalled()
    const out = lines.join('\n')
    expect(out).toContain('[w1]  would free 2.0M')
    // Whether anything was deleted must not be left to inference — said first and last.
    expect(out).toMatch(/^Preview — nothing will be deleted/)
    expect(out).toContain(
      'Preview only — nothing was deleted. --force would delete 2.0M of build output',
    )
    // What is kept is its own sentence, so it cannot read as part of what gets deleted.
    expect(out).toMatch(/\nIt keeps everything else: source files, commits, uncommitted changes/)
  })

  it('deletes with --force but leaves a live agent alone', async () => {
    scanRemoteWorkspaceUsage.mockResolvedValue({
      id: 'w1',
      present: true,
      agents: [
        agent({ id: 'idle-agent', reclaimable: [{ path: 'target', sizeKb: 10 }] }),
        agent({ id: 'busy-agent', live: true, reclaimable: [{ path: 'target', sizeKb: 99 }] }),
      ],
    })
    const { lines, restore } = captureLogs()
    await runStorageCleanRemoteCommand({ args: { host: 'remote', force: true } })
    restore()

    expect(removeRemoteReclaimableDirs).toHaveBeenCalledTimes(1)
    expect(removeRemoteReclaimableDirs).toHaveBeenCalledWith(
      expect.anything(),
      'w1',
      'idle-agent',
      ['target'],
      { includeLive: false },
    )
    expect(lines.join('\n')).toContain('skipped — live session')
  })

  it('cleans a live agent only when asked to', async () => {
    scanRemoteWorkspaceUsage.mockResolvedValue({
      id: 'w1',
      present: true,
      agents: [agent({ live: true, reclaimable: [{ path: 'target', sizeKb: 99 }] })],
    })
    const { restore } = captureLogs()
    await runStorageCleanRemoteCommand({
      args: { host: 'remote', force: true, 'include-live': true },
    })
    restore()
    expect(removeRemoteReclaimableDirs).toHaveBeenCalledTimes(1)
  })

  it('skips an agent active within --min-idle even with no session, and honors --min-idle 0', async () => {
    scanRemoteWorkspaceUsage.mockResolvedValue({
      id: 'w1',
      present: true,
      agents: [
        agent({
          lastActiveAt: Date.now() - 5 * 60_000,
          reclaimable: [{ path: 'target', sizeKb: 99 }],
        }),
      ],
    })
    const { lines, restore } = captureLogs()
    await runStorageCleanRemoteCommand({ args: { host: 'remote', force: true } })
    expect(removeRemoteReclaimableDirs).not.toHaveBeenCalled()
    expect(lines.join('\n')).toMatch(/skipped — active 5m ago/)

    await runStorageCleanRemoteCommand({ args: { host: 'remote', force: true, 'min-idle': '0' } })
    restore()
    expect(removeRemoteReclaimableDirs).toHaveBeenCalledTimes(1)
  })

  it('reports an agent that started a session between the scan and the delete as skipped', async () => {
    scanRemoteWorkspaceUsage.mockResolvedValue({
      id: 'w1',
      present: true,
      agents: [agent({ reclaimable: [{ path: 'target', sizeKb: 99 }] })],
    })
    removeRemoteReclaimableDirs.mockResolvedValueOnce({ removed: [], live: true })
    const { lines, restore } = captureLogs()
    await runStorageCleanRemoteCommand({ args: { host: 'remote', force: true } })
    restore()
    const out = lines.join('\n')
    expect(out).toContain('started a session during the sweep')
    expect(out).toContain('Nothing deleted — no idle build output found')
  })

  it('passes the deletion-time live re-check through, unless --include-live', async () => {
    scanRemoteWorkspaceUsage.mockResolvedValue({
      id: 'w1',
      present: true,
      agents: [agent({ reclaimable: [{ path: 'target', sizeKb: 9 }] })],
    })
    const { restore } = captureLogs()
    await runStorageCleanRemoteCommand({ args: { host: 'remote', force: true } })
    restore()
    expect(removeRemoteReclaimableDirs).toHaveBeenCalledWith(
      expect.anything(),
      'w1',
      'abcdef1234',
      ['target'],
      { includeLive: false },
    )
  })

  it('rejects an unparseable --min-idle', async () => {
    await expect(
      runStorageCleanRemoteCommand({ args: { host: 'remote', 'min-idle': 'soon' } }),
    ).rejects.toThrow(/not a duration/)
  })

  it('--sandboxes previews orphans — no agent dir, no live session — and removes them with --force', async () => {
    scanRemoteWorkspaceUsage.mockResolvedValue(quietUsage('w1'))
    listRemoteAgentIds.mockResolvedValue(new Set(['aaaaaaaa-0000']))
    listRemoteLiveSessions.mockResolvedValue(new Set(['qb-cccccccc']))
    listQuimbySandboxes.mockResolvedValue({
      clis: ['sbx'],
      sandboxes: [
        { cli: 'sbx', name: 'qb-aaaaaaaa-0123456789ab' }, // owned by an agent dir
        { cli: 'sbx', name: 'qb-bbbbbbbb-0123456789ab' }, // orphan
        { cli: 'sbx', name: 'qb-cccccccc-0123456789ab' }, // live session protects it
      ],
    })
    const { lines, restore } = captureLogs()
    await runStorageCleanRemoteCommand({ args: { host: 'remote', sandboxes: true } })
    expect(removeQuimbySandboxes).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('would remove sbx sandbox qb-bbbbbbbb-0123456789ab')

    await runStorageCleanRemoteCommand({ args: { host: 'remote', sandboxes: true, force: true } })
    restore()
    expect(removeQuimbySandboxes).toHaveBeenCalledWith(expect.anything(), [
      { cli: 'sbx', name: 'qb-bbbbbbbb-0123456789ab' },
    ])
    listRemoteLiveSessions.mockResolvedValue(new Set())
  })

  it('--sandboxes still runs on a host with no workspaces left — where orphans pile up', async () => {
    listRemoteWorkspaces.mockResolvedValue([])
    listQuimbySandboxes.mockResolvedValue({
      clis: ['sbx'],
      sandboxes: [{ cli: 'sbx', name: 'qb-bbbbbbbb-0123456789ab' }],
    })
    const { restore } = captureLogs()
    await runStorageCleanRemoteCommand({ args: { host: 'remote', sandboxes: true, force: true } })
    restore()
    expect(removeQuimbySandboxes).toHaveBeenCalled()
  })

  it('scopes to one workspace with --id, accepting the short id a listing prints', async () => {
    listRemoteWorkspaces.mockResolvedValue([
      { id: 'b20d2d32-7ba3-4eb9-af52-1', sourceRepo: 'https://github.com/o/flight-rs-new' },
      { id: '4611d72d-6367-41cb-8cd3-1' },
    ])
    scanRemoteWorkspaceUsage.mockResolvedValue(quietUsage('b20d2d32-7ba3-4eb9-af52-1'))
    const { restore } = captureLogs()
    await runStorageCleanRemoteCommand({ args: { host: 'remote', id: 'b20d2d32' } })
    restore()
    expect(scanRemoteWorkspaceUsage).toHaveBeenCalledTimes(1)
    expect(scanRemoteWorkspaceUsage).toHaveBeenCalledWith(
      expect.anything(),
      'b20d2d32-7ba3-4eb9-af52-1',
      expect.anything(),
    )
  })

  it('after --force, reports the measured free space before and after', async () => {
    const { getRemoteHostOverview } = await import('@quimbyhq/workspace')
    vi.mocked(getRemoteHostOverview).mockResolvedValueOnce({
      disk: { totalKb: 4 * 1024 ** 3, usedKb: 3 * 1024 ** 3, availKb: 1024 ** 3, mount: '/' },
      workspaces: [{ id: 'w1' }],
      liveSessions: new Set(),
    })
    getRemoteDiskUsage.mockResolvedValueOnce({
      totalKb: 4 * 1024 ** 3,
      usedKb: 2 * 1024 ** 3,
      availKb: 2 * 1024 ** 3,
      mount: '/',
    } as never)
    scanRemoteWorkspaceUsage.mockResolvedValue({
      id: 'w1',
      present: true,
      agents: [agent({ reclaimable: [{ path: 'target', sizeKb: 1024 ** 3 }] })],
    })
    const { lines, restore } = captureLogs()
    await runStorageCleanRemoteCommand({ args: { host: 'remote', force: true } })
    restore()
    expect(lines.join('\n')).toContain(
      'Freed 1.0T of build output. "remote" free space: 1.0T → 2.0T.',
    )
  })

  it('names workspaces by repository and agents by name, not by uuid', async () => {
    listRemoteWorkspaces.mockResolvedValue([
      { id: 'b20d2d32-7ba3-4eb9-af52-1', sourceRepo: 'https://github.com/o/flight-rs-new.git' },
    ])
    scanRemoteWorkspaceUsage.mockResolvedValue({
      id: 'b20d2d32-7ba3-4eb9-af52-1',
      present: true,
      agents: [agent({ name: 'builder4', reclaimable: [{ path: 'target', sizeKb: 2048 }] })],
    })
    const { lines, restore } = captureLogs()
    await runStorageCleanRemoteCommand({ args: { host: 'remote' } })
    restore()
    const out = lines.join('\n')
    expect(out).toContain('flight-rs-new [b20d2d32]  would free 2.0M')
    expect(out).toContain('  builder4  2.0M  target 2.0M')
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
  it("previews this repo's duplicates, keeping the active one, unless forced", async () => {
    loadState.mockResolvedValue({ id: 'active-id' })
    listRemoteWorkspaces.mockResolvedValue([
      { id: 'active-id', sourceRepo: 'git@example.com:repo.git' },
      { id: 'dup', sourceRepo: 'git@example.com:repo.git' },
      { id: 'other', sourceRepo: 'https://x/other' },
    ])
    const { lines, restore } = captureLogs()
    await runStoragePruneRemoteCommand({ args: { host: 'remote', force: false } })
    restore()

    const out = lines.join('\n')
    expect(out).toContain('would remove repo [dup]')
    expect(out).not.toContain('active-id  ')
    expect(out).not.toContain('other')
    expect(removeRemoteWorkspace).not.toHaveBeenCalled()
  })

  it('refuses the duplicate sweep when there is no local workspace to protect', async () => {
    loadState.mockRejectedValue(new Error('no state'))
    await expect(
      runStoragePruneRemoteCommand({ args: { host: 'remote', force: true } }),
    ).rejects.toThrow(/adopt one first/)
    expect(removeRemoteWorkspace).not.toHaveBeenCalled()
  })

  it('sweeps dormant workspaces host-wide, but never one holding work or a live session', async () => {
    loadState.mockResolvedValue({ id: 'active-id' })
    const old = Date.now() - 60 * 86_400_000
    listRemoteWorkspaces.mockResolvedValue([{ id: 'stale' }, { id: 'busy' }, { id: 'wip' }])
    scanRemoteWorkspaceUsage.mockImplementation(async (_loc: unknown, id: string) =>
      id === 'busy'
        ? quietUsage(id, { lastActiveAt: old, live: true })
        : id === 'wip'
          ? quietUsage(id, { lastActiveAt: old, dirtyFiles: 3 })
          : quietUsage(id, { lastActiveAt: old }),
    )
    const { lines, restore } = captureLogs()
    await runStoragePruneRemoteCommand({ args: { host: 'remote', idle: '30d', force: true } })
    restore()

    expect(removeRemoteWorkspace).toHaveBeenCalledTimes(1)
    expect(removeRemoteWorkspace).toHaveBeenCalledWith(expect.anything(), 'stale')
    const out = lines.join('\n')
    expect(out).toContain('keeping (no origin) [busy]')
    expect(out).toContain('keeping (no origin) [wip]')
  })

  it('rejects an --idle it cannot parse before touching the host', async () => {
    await expect(
      runStoragePruneRemoteCommand({ args: { host: 'remote', idle: 'ages' } }),
    ).rejects.toThrow(/not a duration/)
    expect(listRemoteWorkspaces).not.toHaveBeenCalled()
  })
})

describe('runStorageRemoveCommand', () => {
  it('requires force for explicit removal', async () => {
    await expect(
      runStorageRemoveCommand({ args: { id: 'proj-id', force: false } }),
    ).rejects.toThrow(/--force/)
  })

  it('removes one workspace when forced', async () => {
    removeStorageWorkspace.mockResolvedValueOnce({ existed: true, sandboxes: NO_SANDBOXES })

    await runStorageRemoveCommand({ args: { id: 'proj-id', force: true } })

    expect(removeStorageWorkspace).toHaveBeenCalledWith('proj-id')
  })
})

describe('runStorageRemoveRemoteCommand', () => {
  beforeEach(() => {
    listRemoteWorkspaces.mockResolvedValue([{ id: 'active-id' }, { id: 'other-id' }])
  })

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
    removeRemoteWorkspace.mockResolvedValue({ removed: true, sandboxes: NO_SANDBOXES })
    await runStorageRemoveRemoteCommand({ args: { id: 'other-id', host: 'remote', force: true } })
    expect(removeRemoteWorkspace).toHaveBeenCalledWith(expect.anything(), 'other-id')
  })

  it('names a sandbox it could not remove, with the command to finish the job', async () => {
    loadState.mockResolvedValue({ id: 'active-id' })
    removeRemoteWorkspace.mockResolvedValue({
      removed: true,
      sandboxes: {
        clis: ['sbx'],
        removed: [],
        failed: [{ cli: 'sbx', name: 'qb-bbbbbbbb-0123456789ab' }],
      },
    })
    const { lines, restore } = captureLogs()
    await runStorageRemoveRemoteCommand({ args: { id: 'other-id', host: 'remote', force: true } })
    restore()
    expect(lines.join('\n')).toContain('sbx rm qb-bbbbbbbb-0123456789ab')
  })

  it('accepts the short id a listing prints, and refuses an ambiguous one', async () => {
    loadState.mockResolvedValue({ id: 'active-id' })
    listRemoteWorkspaces.mockResolvedValue([
      { id: 'b20d2d32-7ba3-1' },
      { id: 'b20d2d32-ffff-1' },
      { id: '4611d72d-6367-1' },
    ])
    await runStorageRemoveRemoteCommand({ args: { id: '4611d72d', host: 'remote', force: true } })
    expect(removeRemoteWorkspace).toHaveBeenCalledWith(expect.anything(), '4611d72d-6367-1')

    removeRemoteWorkspace.mockClear()
    await expect(
      runStorageRemoveRemoteCommand({ args: { id: 'b20d2d32', host: 'remote', force: true } }),
    ).rejects.toThrow(/matches 2/)
    expect(removeRemoteWorkspace).not.toHaveBeenCalled()
  })

  it('refuses a workspace with a live session', async () => {
    loadState.mockResolvedValue({ id: 'active-id' })
    scanRemoteWorkspaceUsage.mockResolvedValue(quietUsage('other-id', { live: true }))
    await expect(
      runStorageRemoveRemoteCommand({ args: { id: 'other-id', host: 'remote', force: true } }),
    ).rejects.toThrow(/live session/)
    expect(removeRemoteWorkspace).not.toHaveBeenCalled()
  })

  it('refuses unlanded work unless --discard-work is passed', async () => {
    loadState.mockResolvedValue({ id: 'active-id' })
    scanRemoteWorkspaceUsage.mockResolvedValue(quietUsage('other-id', { commitsSinceSeed: 4 }))
    await expect(
      runStorageRemoveRemoteCommand({ args: { id: 'other-id', host: 'remote', force: true } }),
    ).rejects.toThrow(/4 commit\(s\)/)
    expect(removeRemoteWorkspace).not.toHaveBeenCalled()

    removeRemoteWorkspace.mockResolvedValue({ removed: true, sandboxes: NO_SANDBOXES })
    await runStorageRemoveRemoteCommand({
      args: { id: 'other-id', host: 'remote', force: true, 'discard-work': true },
    })
    expect(removeRemoteWorkspace).toHaveBeenCalledWith(expect.anything(), 'other-id')
  })
})
