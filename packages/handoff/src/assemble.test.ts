import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAll, commit, init, tag } from '@quimbyhq/git'
import { getAgentDir, getAgentRepoDir, getStagingHandoffDir } from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assembleHandoff,
  assembleHostHandoff,
  assembleRemoteHandoff,
  getWorkingParcelName,
} from './assemble'

vi.mock('@quimbyhq/transport', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    getSSHTransport: vi.fn(() => ({
      exec: vi.fn(async () => ''),
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(),
      fileExists: vi.fn(async () => false),
      ensureDir: vi.fn(),
      rsyncFrom: vi.fn(),
      rsyncTo: vi.fn(),
    })),
  }
})

let dir: string

async function configureGit(cwd: string) {
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd })
}

async function setupRepoRoot(): Promise<string> {
  const repoRoot = join(tmpdir(), `quimby-assemble-${crypto.randomUUID()}`)
  await mkdir(repoRoot, { recursive: true })
  await execa('git', ['init'], { cwd: repoRoot })
  await configureGit(repoRoot)
  await writeFile(join(repoRoot, 'README.md'), '# Project')
  await execa('git', ['add', '-A'], { cwd: repoRoot })
  await execa('git', ['commit', '-m', 'initial'], { cwd: repoRoot })
  await ensureWorkspace(repoRoot)
  await execa('git', ['add', '.gitignore'], { cwd: repoRoot })
  await execa('git', ['commit', '-m', 'gitignore .quimby'], { cwd: repoRoot })
  return repoRoot
}

async function setupAgentRepo(repoRoot: string, agentName: string): Promise<string> {
  const agentRepoDir = getAgentRepoDir(repoRoot, agentName)
  const agentDir = getAgentDir(repoRoot, agentName)
  await mkdir(join(agentDir, 'inbox', 'status'), { recursive: true })
  await mkdir(join(agentDir, 'outbox'), { recursive: true })
  await mkdir(agentRepoDir, { recursive: true })
  await init(agentRepoDir)
  await configureGit(agentRepoDir)
  await writeFile(join(agentRepoDir, 'base.txt'), 'base content\n')
  await addAll(agentRepoDir)
  await commit(agentRepoDir, 'base commit')
  await tag(agentRepoDir, 'quimby/seed')
  return agentRepoDir
}

async function withFeatureCommit(agentRepoDir: string): Promise<void> {
  await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
  await addAll(agentRepoDir)
  await commit(agentRepoDir, 'add feature')
}

beforeEach(async () => {
  dir = await setupRepoRoot()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('assembleHandoff', () => {
  it('carries a different code source than the sender (attach)', async () => {
    await setupAgentRepo(dir, 'review')
    const builderRepo = await setupAgentRepo(dir, 'builder')
    await withFeatureCommit(builderRepo)
    const meta = await assembleHandoff({
      repoRoot: dir,
      from: 'review',
      codeSource: 'builder',
      codeSourceId: 'builder',
      note: 'promote this',
    })
    expect(meta.from).toBe('review')
    expect(meta.codeSource).toBe('builder')
    expect(meta.commits).toHaveLength(1)
    const parcel = getStagingHandoffDir(dir, meta.name)
    expect(await exists(join(parcel, 'squashed.diff'))).toBe(true)
    expect(await exists(join(parcel, 'README.md'))).toBe(true)
  })

  it('names the parcel <from>-<short-sha> of the packed tip', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    expect(meta.name).toMatch(/^alice-[0-9a-f]{8}$/)
  })

  it('stages a code parcel with squashed.diff and meta.yaml', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const parcel = getStagingHandoffDir(dir, meta.name)
    expect(await exists(join(parcel, 'squashed.diff'))).toBe(true)
    expect(await exists(join(parcel, 'meta.yaml'))).toBe(true)
    expect(meta.commits).toHaveLength(1)
  })

  it('never carries the agent repo .quimby dir, even without a .gitignore', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await mkdir(join(agentRepoDir, '.quimby', 'agents'), { recursive: true })
    await writeFile(join(agentRepoDir, '.quimby', 'state.yaml'), 'id: leaked\n')
    await writeFile(join(agentRepoDir, 'feature.txt'), 'real work\n')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const squashed = await readFile(
      join(getStagingHandoffDir(dir, meta.name), 'squashed.diff'),
      'utf-8',
    )
    expect(squashed).toContain('feature.txt')
    expect(squashed).not.toContain('.quimby')
    expect(squashed).not.toContain('state.yaml')
  })

  it('stages a note-only parcel when there is no code', async () => {
    await setupAgentRepo(dir, 'review')
    const meta = await assembleHandoff({
      repoRoot: dir,
      from: 'review',
      codeSourceId: 'review',
      note: 'fix the null case',
    })
    const parcel = getStagingHandoffDir(dir, meta.name)
    expect(await exists(join(parcel, 'README.md'))).toBe(true)
    expect(await exists(join(parcel, 'squashed.diff'))).toBe(false)
    expect(meta.note).toBe('fix the null case')
    expect(meta.commits).toHaveLength(0)
  })

  it('sets suggestedMessage to the last commit subject when there are multiple commits', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await writeFile(join(agentRepoDir, 'first.txt'), 'first\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'first commit')
    await writeFile(join(agentRepoDir, 'second.txt'), 'second\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'second commit')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    expect(meta.suggestedMessage).toBe('first commit')
    expect(meta.commits).toHaveLength(2)
  })

  it('throws when there is neither code nor a note', async () => {
    await setupAgentRepo(dir, 'alice')
    await expect(
      assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' }),
    ).rejects.toThrow('Nothing to hand off')
  })
})

describe('assembleHostHandoff', () => {
  it('stages a parcel from the host working tree against a base', async () => {
    const base = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
    await writeFile(join(dir, 'README.md'), '# Project changed by host')
    const meta = await assembleHostHandoff({
      repoRoot: dir,
      to: 'review',
      base,
      note: 'please look',
    })
    expect(meta.from).toBe('host')
    expect(meta.to).toBe('review')
    const parcel = getStagingHandoffDir(dir, meta.name)
    expect(await exists(join(parcel, 'squashed.diff'))).toBe(true)
    expect(await exists(join(parcel, 'README.md'))).toBe(true)
  })

  it('throws when the host has no changes and no note', async () => {
    const base = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
    await expect(assembleHostHandoff({ repoRoot: dir, to: 'review', base })).rejects.toThrow(
      'Nothing to hand off',
    )
  })
})

describe('assembleRemoteHandoff', () => {
  function recordingTransport(): {
    transport: ReturnType<typeof getSSHTransport>
    calls: string[]
  } {
    const calls: string[] = []
    const transport = {
      exec: vi.fn(async (cmd: string) => {
        calls.push(cmd)
        return ''
      }),
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(),
      fileExists: vi.fn(async () => false),
      ensureDir: vi.fn(),
      rsyncFrom: vi.fn(),
      rsyncTo: vi.fn(),
    } as unknown as ReturnType<typeof getSSHTransport>
    return { transport, calls }
  }

  const sshLocation = { type: 'ssh', host: 'user@box', base: '~' } as const

  it('assembles a note-only parcel over transport when the remote has no diff', async () => {
    const repoRoot = await setupRepoRoot()
    const { transport } = recordingTransport()
    vi.mocked(getSSHTransport).mockReturnValue(transport)

    const meta = await assembleRemoteHandoff({
      repoRoot,
      from: 'remote',
      codeSourceId: 'remote-id',
      codeSourceLocation: sshLocation,
      projectId: 'proj',
      note: 'take a look',
    })

    expect(meta.name).toMatch(/^remote-[0-9a-f]{8}$/)
    expect(meta.note).toBe('take a look')
    expect(await exists(join(getStagingHandoffDir(repoRoot, meta.name), 'README.md'))).toBe(true)
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('issues the expected remote git reads (seed, subjects, working-tree diff)', async () => {
    const repoRoot = await setupRepoRoot()
    const { transport, calls } = recordingTransport()
    vi.mocked(getSSHTransport).mockReturnValue(transport)

    await assembleRemoteHandoff({
      repoRoot,
      from: 'remote',
      codeSourceId: 'remote-id',
      codeSourceLocation: sshLocation,
      projectId: 'proj',
      note: 'n',
    })

    expect(calls).toContain('git rev-parse quimby/seed')
    expect(calls).toContain('git log quimby/seed..HEAD --format=%s')
    // the commit-free working-tree capture uses a throwaway index
    expect(calls.some((c) => c.includes('git read-tree') && c.includes('GIT_INDEX_FILE'))).toBe(
      true,
    )
    await rm(repoRoot, { recursive: true, force: true })
  })
})

describe('getWorkingParcelName', () => {
  it('matches the name assembleHandoff assigns the same code-only tree', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const live = await getWorkingParcelName({
      repoRoot: dir,
      from: 'alice',
      codeSourceId: 'alice',
      location: { type: 'local' },
      projectId: 'p',
    })
    expect(live).toBe(meta.name)
  })

  it('changes once the working tree drifts from the parcel', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    await writeFile(join(agentRepoDir, 'feature.txt'), 'edited after the parcel\n')
    const live = await getWorkingParcelName({
      repoRoot: dir,
      from: 'alice',
      codeSourceId: 'alice',
      location: { type: 'local' },
      projectId: 'p',
    })
    expect(live).not.toBe(meta.name)
  })
})
