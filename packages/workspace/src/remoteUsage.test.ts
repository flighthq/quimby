import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import type { SSHLocation } from '@quimbyhq/types'
import { execa } from 'execa'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Run the generated remote scripts for real, with $HOME pointed at a scratch dir — the shell is
// the part most likely to be wrong, so mocking it out would test only the parser.
const fakeHome = vi.hoisted(() => ({ dir: '' }))
const exec = vi.hoisted(() =>
  vi.fn(async (cmd: string, opts?: { input?: string }) => {
    const { execa: run } = await import('execa')
    const { stdout } = await run('sh', ['-c', cmd], {
      env: { HOME: fakeHome.dir },
      ...(opts?.input === undefined ? {} : { input: opts.input }),
      reject: false,
      stripFinalNewline: false,
    })
    return stdout
  }),
)
vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: () => ({ exec }),
}))

import type { RemoteWorkspaceUsage } from './remoteUsage'
import {
  getRemoteWorkspaceLastActiveAt,
  getRemoteWorkspaceReclaimableKb,
  getRemoteWorkspaceUnlandedWork,
  isReclaimableIgnoredPath,
  isValidStorageMinFree,
  listRemoteAgentIds,
  parseRemoteDiskUsage,
  parseRemoteWorkspaceUsage,
  remoteDiskWarning,
  removeRemoteReclaimableDirs,
  resolveStorageMinFreeKb,
  scanRemoteWorkspaceUsage,
  selectOrphanSandboxes,
  selectRemoteWorkspacePruneCandidates,
} from './remoteUsage'

const location = { type: 'ssh', host: 'box' } as SSHLocation & { host: string }
const WS = 'ws-1'
const AGENT = 'abcdef12-0000-0000-0000-000000000000'

beforeEach(async () => {
  fakeHome.dir = await mkdtemp(join(tmpdir(), 'qb-remote-usage-'))
})

afterEach(async () => {
  vi.clearAllMocks()
  await rm(fakeHome.dir, { recursive: true, force: true })
})

async function makeAgentRepo(): Promise<string> {
  const agentDir = join(fakeHome.dir, '.quimby/workspaces', WS, '.quimby/agents', AGENT)
  const repo = join(agentDir, 'repo')
  await mkdir(repo, { recursive: true })
  const git = (...args: string[]) =>
    execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo })
  await git('init', '-q')
  await writeFile(join(repo, '.gitignore'), 'target/\n.env\nsecrets/\nvendor/\n')
  await writeFile(join(repo, 'a.txt'), 'a')
  await git('add', '.')
  await git('commit', '-qm', 'seed')
  await git('tag', 'quimby/seed')
  await writeFile(join(agentDir, 'status.md'), 'working')
  await writeFile(
    join(agentDir, 'CLAUDE.md'),
    'You are **builder4**, one of several agents.\n\nmore',
  )
  await mkdir(join(repo, 'target/debug'), { recursive: true })
  await writeFile(join(repo, 'target/debug/big.bin'), Buffer.alloc(64 * 1024))
  await writeFile(join(repo, '.env'), 'TOKEN=x')
  await mkdir(join(repo, 'secrets'), { recursive: true })
  await writeFile(join(repo, 'secrets/key'), 'k')
  // An ignored directory that is itself someone's checkout must never read as build output.
  await mkdir(join(repo, 'vendor/.git'), { recursive: true })
  return repo
}

function usage(partial: Partial<RemoteWorkspaceUsage> & { id: string }): RemoteWorkspaceUsage {
  return { present: true, agents: [], ...partial }
}

describe('getRemoteWorkspaceLastActiveAt', () => {
  it('takes the newest agent and is undefined when none recorded anything', () => {
    const live = (lastActiveAt?: number) => ({
      id: 'a',
      live: false,
      reclaimable: [],
      ...(lastActiveAt ? { lastActiveAt } : {}),
    })
    expect(
      getRemoteWorkspaceLastActiveAt(usage({ id: 'w', agents: [live(5), live(9), live()] })),
    ).toBe(9)
    expect(getRemoteWorkspaceLastActiveAt(usage({ id: 'w', agents: [live()] }))).toBeUndefined()
  })
})

describe('getRemoteWorkspaceReclaimableKb', () => {
  it('sums every agent', () => {
    const u = usage({
      id: 'w',
      agents: [
        { id: 'a', live: false, reclaimable: [{ path: 'target', sizeKb: 10 }] },
        { id: 'b', live: false, reclaimable: [{ path: 'obj', sizeKb: 5 }] },
      ],
    })
    expect(getRemoteWorkspaceReclaimableKb(u)).toBe(15)
  })
})

describe('getRemoteWorkspaceUnlandedWork', () => {
  it('flags an unreadable agent as unknown rather than counting it as empty', () => {
    const u = usage({
      id: 'w',
      agents: [
        { id: 'a', live: false, reclaimable: [], commitsSinceSeed: 2, dirtyFiles: 1 },
        { id: 'b', live: false, reclaimable: [] },
      ],
    })
    expect(getRemoteWorkspaceUnlandedWork(u)).toEqual({ commits: 2, dirtyFiles: 1, unknown: true })
  })
})

describe('isReclaimableIgnoredPath', () => {
  it('accepts ordinary build directories, nested ones included', () => {
    expect(isReclaimableIgnoredPath('target')).toBe(true)
    expect(isReclaimableIgnoredPath('packages/app/node_modules')).toBe(true)
    expect(isReclaimableIgnoredPath('Export/hl/obj')).toBe(true)
  })

  it('refuses anything that names a secret, wherever in the path', () => {
    for (const p of ['.env', '.env.d', 'config/secrets', 'creds/credentials', 'tls/server.pem']) {
      expect(isReclaimableIgnoredPath(p)).toBe(false)
    }
  })

  it('refuses paths that could escape the repo or hit git/quimby state', () => {
    for (const p of ['', '/etc', '../x', 'a/../../b', '.git', 'x/.quimby', '.', 'a//b']) {
      expect(isReclaimableIgnoredPath(p)).toBe(false)
    }
  })
})

describe('isValidStorageMinFree', () => {
  it('accepts sizes and percentages, rejects nonsense', () => {
    expect(isValidStorageMinFree(undefined)).toBe(true)
    expect(isValidStorageMinFree('100G')).toBe(true)
    expect(isValidStorageMinFree('10%')).toBe(true)
    expect(isValidStorageMinFree(50)).toBe(true)
    expect(isValidStorageMinFree('150%')).toBe(false)
    expect(isValidStorageMinFree('plenty')).toBe(false)
  })
})

describe('listRemoteAgentIds', () => {
  it('collects agent dir names across every workspace on the host', async () => {
    await makeAgentRepo()
    await mkdir(join(fakeHome.dir, '.quimby/workspaces/ws-2/.quimby/agents/other-agent'), {
      recursive: true,
    })
    expect([...(await listRemoteAgentIds(location))].sort()).toEqual([AGENT, 'other-agent'])
  })

  it('is empty, not an error, on a host with no workspaces', async () => {
    expect((await listRemoteAgentIds(location)).size).toBe(0)
  })
})

describe('parseRemoteDiskUsage', () => {
  it('reads the last df -P row, keeping a mount point with spaces whole', () => {
    const out =
      'Welcome!\nFilesystem 1024-blocks Used Available Capacity Mounted on\n' +
      '/dev/sda2 1900000000 1500000000 400000000 79% /home/my disk\n'
    expect(parseRemoteDiskUsage(out)).toEqual({
      totalKb: 1_900_000_000,
      usedKb: 1_500_000_000,
      availKb: 400_000_000,
      mount: '/home/my disk',
    })
  })

  it('returns null when there is no row', () => {
    expect(parseRemoteDiskUsage('df: not found\n')).toBeNull()
  })
})

describe('parseRemoteWorkspaceUsage', () => {
  it('ignores noise, drops nested repos and protected paths, and sorts reclaimable by size', () => {
    const out = [
      'motd line',
      'QBIG\tag1\t10\t0\tsmall',
      'QBIG\tag1\t500\t0\ttarget',
      'QBIG\tag1\t99\t1\tvendor',
      'QBIG\tag1\t7\t0\tsecrets',
      'QBAG\tag1\t1700000000\t3\t-',
      'QBTOT\t2048',
    ].join('\n')
    const u = parseRemoteWorkspaceUsage('w', out, new Set(['qb-ag1']))
    expect(u.sizeKb).toBe(2048)
    expect(u.agents).toEqual([
      {
        id: 'ag1',
        lastActiveAt: 1_700_000_000_000,
        commitsSinceSeed: 3,
        live: true,
        reclaimable: [
          { path: 'target', sizeKb: 500 },
          { path: 'small', sizeKb: 10 },
        ],
      },
    ])
  })

  it('reports a workspace that vanished between listing and scanning', () => {
    expect(parseRemoteWorkspaceUsage('w', 'QBGONE\n', new Set()).present).toBe(false)
  })
})

describe('remoteDiskWarning', () => {
  const disk = { totalKb: 1000, usedKb: 950, availKb: 50, mount: '/' }

  it('warns below the default 10% and names the remedy', () => {
    const msg = remoteDiskWarning(disk, {}, 'remote')
    expect(msg).toContain('low on disk')
    expect(msg).toContain('quimby storage clean-remote --host remote')
  })

  it('stays quiet with room, or when the disk could not be read', () => {
    expect(remoteDiskWarning({ ...disk, availKb: 200 }, {}, 'remote')).toBeNull()
    expect(remoteDiskWarning(null, {}, 'remote')).toBeNull()
  })

  it('honors a configured threshold', () => {
    expect(remoteDiskWarning(disk, { storage: { minFree: '4%' } }, 'r')).toBeNull()
  })
})

describe('removeRemoteReclaimableDirs', () => {
  it('deletes only validated paths and leaves everything else in the repo alone', async () => {
    const repo = await makeAgentRepo()
    const out = await removeRemoteReclaimableDirs(location, WS, AGENT, [
      'target',
      '.env',
      '../../status.md',
    ])
    expect(out).toEqual({ removed: ['target'], live: false })
    expect(existsSync(join(repo, 'target'))).toBe(false)
    expect(existsSync(join(repo, '.env'))).toBe(true)
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
    expect(existsSync(join(repo, '../status.md'))).toBe(true)
  })

  it('re-checks for a live session at deletion time and removes nothing when it finds one', async () => {
    // The scan that judged the agent idle can be minutes old; an agent started since must win.
    const repo = await makeAgentRepo()
    const session = `qb-${AGENT.slice(0, 8)}`
    await execa('tmux', ['-L', 'quimby', 'new-session', '-d', '-s', session, 'sleep 30'])
    try {
      const out = await removeRemoteReclaimableDirs(location, WS, AGENT, ['target'])
      expect(out).toEqual({ removed: [], live: true })
      expect(existsSync(join(repo, 'target'))).toBe(true)

      const forced = await removeRemoteReclaimableDirs(location, WS, AGENT, ['target'], {
        includeLive: true,
      })
      expect(forced.removed).toEqual(['target'])
    } finally {
      await execa('tmux', ['-L', 'quimby', 'kill-session', '-t', `=${session}`], { reject: false })
    }
  })

  it('matches the session name exactly, not as a prefix', async () => {
    await makeAgentRepo()
    const longer = `qb-${AGENT.slice(0, 8)}x`
    await execa('tmux', ['-L', 'quimby', 'new-session', '-d', '-s', longer, 'sleep 30'])
    try {
      const out = await removeRemoteReclaimableDirs(location, WS, AGENT, ['target'])
      expect(out.live).toBe(false)
    } finally {
      await execa('tmux', ['-L', 'quimby', 'kill-session', '-t', `=${longer}`], { reject: false })
    }
  })
})

describe('resolveStorageMinFreeKb', () => {
  it('reads percentages and absolute sizes, defaulting to 10%', () => {
    expect(resolveStorageMinFreeKb({ storage: { minFree: '25%' } }, 1000)).toBe(250)
    expect(resolveStorageMinFreeKb({ storage: { minFree: '1M' } }, 1000)).toBe(1024)
    expect(resolveStorageMinFreeKb({ storage: { minFree: 'junk' } }, 1000)).toBe(100)
    expect(resolveStorageMinFreeKb(undefined, 1000)).toBe(100)
  })
})

describe('scanRemoteWorkspaceUsage', () => {
  it('measures activity, unlanded work and reclaimable build output against a real repo', async () => {
    const repo = await makeAgentRepo()
    await writeFile(join(repo, 'wip.txt'), 'uncommitted')
    const u = await scanRemoteWorkspaceUsage(location, WS, {
      sizes: true,
      liveSessions: new Set(),
    })
    expect(u.present).toBe(true)
    expect(u.sizeKb).toBeGreaterThan(0)
    const [agent] = u.agents
    expect(agent.id).toBe(AGENT)
    expect(agent.name).toBe('builder4')
    expect(agent.commitsSinceSeed).toBe(0)
    expect(agent.dirtyFiles).toBe(1)
    expect(agent.lastActiveAt).toBeGreaterThan(Date.now() - 60_000)
    // target/ is offered; .env is a file, secrets/ is protected, vendor/ is a nested repo.
    expect(agent.reclaimable.map((d) => d.path)).toEqual(['target'])
    expect(agent.reclaimable[0].sizeKb).toBeGreaterThanOrEqual(64)
  })

  it('skips the du walk when sizes are not asked for', async () => {
    await makeAgentRepo()
    const u = await scanRemoteWorkspaceUsage(location, WS, { liveSessions: new Set() })
    expect(u.sizeKb).toBeUndefined()
    expect(u.agents[0].reclaimable).toEqual([])
  })

  it('marks an agent with a session on the quimby socket as live', async () => {
    await makeAgentRepo()
    const u = await scanRemoteWorkspaceUsage(location, WS, {
      liveSessions: new Set([`qb-${AGENT.slice(0, 8)}`]),
    })
    expect(u.agents[0].live).toBe(true)
  })

  it('reports an agent with no seed tag as unknown work, not zero', async () => {
    const repo = await makeAgentRepo()
    await execa('git', ['tag', '-d', 'quimby/seed'], { cwd: repo })
    const u = await scanRemoteWorkspaceUsage(location, WS, { liveSessions: new Set() })
    expect(u.agents[0].commitsSinceSeed).toBeUndefined()
  })
})

describe('selectOrphanSandboxes', () => {
  const sbx = (name: string) => ({ cli: 'sbx' as const, name })

  it('keeps sandboxes an agent dir or a live session accounts for', () => {
    const out = selectOrphanSandboxes(
      [
        sbx('qb-abcdef12-0123456789ab'),
        sbx('qb-11111111-0123456789ab'),
        sbx('qb-22222222-0123456789ab'),
      ],
      new Set([AGENT]),
      new Set(['qb-11111111']),
    )
    expect(out.map((s) => s.name)).toEqual(['qb-22222222-0123456789ab'])
  })
})

describe('selectRemoteWorkspacePruneCandidates', () => {
  const now = 100 * 86_400_000
  const day = 86_400_000
  const quiet = (id: string, lastActiveAt: number, extra = {}) => ({
    id,
    sourceRepo: `https://x/${id}`,
    usage: usage({
      id,
      agents: [
        {
          id: `${id}-a`,
          live: false,
          reclaimable: [],
          lastActiveAt,
          commitsSinceSeed: 0,
          dirtyFiles: 0,
          ...extra,
        },
      ],
    }),
  })
  const ownership = {
    activeId: 'active',
    claimed: new Map([
      ['gone', { repoRoot: '/old', projectPresent: false }],
      ['here', { repoRoot: '/here', projectPresent: true }],
    ]),
  }

  it('qualifies by idle age, project gone and unclaimed, naming each reason', () => {
    const out = selectRemoteWorkspacePruneCandidates(
      [quiet('gone', now - 40 * day), quiet('here', now - day), quiet('stray', now - day)],
      ownership,
      { now, idleMs: 30 * day, gone: true, unclaimed: true },
    )
    expect(out.map((c) => [c.id, c.reasons, c.blocked])).toEqual([
      ['gone', ['idle 40d', 'project gone: /old'], undefined],
      ['stray', ['unclaimed on this machine'], undefined],
    ])
  })

  it('never offers the active workspace, however idle', () => {
    const out = selectRemoteWorkspacePruneCandidates([quiet('active', 0)], ownership, {
      now,
      idleMs: day,
    })
    expect(out).toEqual([])
  })

  it('lists but blocks a workspace that is live or holds work', () => {
    const out = selectRemoteWorkspacePruneCandidates(
      [
        quiet('a', 0, { live: true }),
        quiet('b', 0, { commitsSinceSeed: 2 }),
        quiet('c', 0, { dirtyFiles: undefined }),
      ],
      ownership,
      { now, idleMs: day },
    )
    expect(out.map((c) => c.blocked)).toEqual([
      '1 live session(s)',
      'holds unlanded work (2 commit(s), 0 dirty file(s))',
      'an agent repo could not be read — it may hold work',
    ])
  })

  it('keeps the duplicate sweep of the original prune-remote', () => {
    const dup = { ...quiet('old', now), sourceRepo: 'https://x/repo' }
    const out = selectRemoteWorkspacePruneCandidates([dup], ownership, {
      now,
      duplicatesOf: { sourceRepo: 'https://x/repo' },
    })
    expect(out[0].reasons).toEqual(["duplicate of this repo's workspace"])
  })
})
