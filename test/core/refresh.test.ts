import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as git from '../../src/utils/git.js'
import { refreshSandbox } from '../../src/core/refresh.js'
import { LocalTransport } from '../../src/core/transport/local.js'
import type { SandboxState } from '../../src/types/workspace.js'

let tmp: string
let sourceRepo: string
let workspacePath: string
let sandboxPath: string
let repoPath: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-refresh-test-'))
  sourceRepo = join(tmp, 'source')
  workspacePath = join(tmp, 'workspace')
  sandboxPath = join(workspacePath, 'sandboxes', 'backend')
  repoPath = join(sandboxPath, 'repo')

  await mkdir(sourceRepo, { recursive: true })
  await git.init(sourceRepo)
  await writeFile(join(sourceRepo, 'file.txt'), 'initial')
  await git.addAll(sourceRepo)
  await git.commit(sourceRepo, 'initial')

  await mkdir(join(sandboxPath, '.sandbox'), { recursive: true })
  await git.clone(sourceRepo, repoPath, { ref: 'master' })
  await git.tag(repoPath, 'ao/seed')
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function makeSandboxState(overrides?: Partial<SandboxState>): SandboxState {
  return {
    name: 'backend',
    status: 'idle',
    runtimeType: 'docker-sandbox',
    seedCommit: 'initial',
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('refreshSandbox', () => {
  it('updates seed to latest source commit', async () => {
    await writeFile(join(sourceRepo, 'update.txt'), 'updated')
    await git.addAll(sourceRepo)
    await git.commit(sourceRepo, 'source update')

    const transport = new LocalTransport(sandboxPath)
    const sandbox = makeSandboxState()

    const result = await refreshSandbox({
      workspacePath,
      sandbox,
      sourceRepo,
      sourceRef: 'master',
      transport,
    })

    expect(result.newSeed).not.toBe(result.previousSeed)
    expect(result.hadUnbundledWork).toBe(false)
    expect(result.stashed).toBe(false)

    const newSeed = await git.revParse(repoPath, 'ao/seed')
    expect(newSeed).toBe(result.newSeed)
  })

  it('rejects when sandbox has uncommitted changes without --force', async () => {
    await writeFile(join(repoPath, 'dirty.txt'), 'dirty')

    const transport = new LocalTransport(sandboxPath)
    const sandbox = makeSandboxState()

    await expect(
      refreshSandbox({
        workspacePath,
        sandbox,
        sourceRepo,
        sourceRef: 'master',
        transport,
      }),
    ).rejects.toThrow('uncommitted changes')
  })

  it('rejects when sandbox has unbundled commits without --force', async () => {
    await writeFile(join(repoPath, 'work.txt'), 'work')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'unbundled work')

    const transport = new LocalTransport(sandboxPath)
    const sandbox = makeSandboxState()

    await expect(
      refreshSandbox({
        workspacePath,
        sandbox,
        sourceRepo,
        sourceRef: 'master',
        transport,
      }),
    ).rejects.toThrow('unbundled commits')
  })

  it('force-refreshes with uncommitted changes', async () => {
    await writeFile(join(sourceRepo, 'new.txt'), 'new')
    await git.addAll(sourceRepo)
    await git.commit(sourceRepo, 'new commit')

    await writeFile(join(repoPath, 'dirty.txt'), 'dirty')
    await git.addAll(repoPath)

    const transport = new LocalTransport(sandboxPath)
    const sandbox = makeSandboxState()

    const result = await refreshSandbox({
      workspacePath,
      sandbox,
      sourceRepo,
      sourceRef: 'master',
      transport,
      force: true,
    })

    expect(result.stashed).toBe(true)
    expect(result.newSeed).not.toBe(result.previousSeed)
  })

  it('force-refreshes with unbundled commits', async () => {
    await writeFile(join(sourceRepo, 'upstream.txt'), 'upstream')
    await git.addAll(sourceRepo)
    await git.commit(sourceRepo, 'upstream')

    await writeFile(join(repoPath, 'sandbox-work.txt'), 'work')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'sandbox work')

    const transport = new LocalTransport(sandboxPath)
    const sandbox = makeSandboxState()

    const result = await refreshSandbox({
      workspacePath,
      sandbox,
      sourceRepo,
      sourceRef: 'master',
      transport,
      force: true,
    })

    expect(result.hadUnbundledWork).toBe(true)
    expect(result.newSeed).not.toBe(result.previousSeed)
  })
})
