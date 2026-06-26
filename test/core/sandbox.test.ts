import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { scaffoldSandbox } from '../../src/core/sandbox.js'
import { exists, readText } from '../../src/utils/fs.js'
import * as git from '../../src/utils/git.js'

let tmp: string
let sourceRepo: string
let workspacePath: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-sandbox-test-'))
  sourceRepo = join(tmp, 'source')
  workspacePath = join(tmp, 'workspace')

  await mkdir(sourceRepo, { recursive: true })
  await git.init(sourceRepo)
  await writeFile(join(sourceRepo, 'file.txt'), 'source content')
  await git.addAll(sourceRepo)
  await git.commit(sourceRepo, 'initial')
  await mkdir(workspacePath, { recursive: true })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('scaffoldSandbox', () => {
  it('creates sandbox directory structure', async () => {
    const state = await scaffoldSandbox({
      workspacePath,
      sandboxName: 'backend',
      sourceRepo,
      sourceRef: 'master',
      config: {
        role: 'Backend engineer',
        runtime: { type: 'docker-sandbox', launch: () => [] },
      },
    })

    const sandboxDir = join(workspacePath, 'sandboxes', 'backend')
    expect(await exists(join(sandboxDir, 'repo', 'file.txt'))).toBe(true)
    expect(await exists(join(sandboxDir, '.sandbox', 'bundles'))).toBe(true)
    expect(await exists(join(sandboxDir, '.sandbox', 'inbox'))).toBe(true)
    expect(await exists(join(sandboxDir, '.sandbox', 'messages'))).toBe(true)
    expect(await exists(join(sandboxDir, '.sandbox', 'assignment.md'))).toBe(true)
    expect(await exists(join(sandboxDir, '.sandbox', 'status.md'))).toBe(true)
  })

  it('tags the repo with ao/seed', async () => {
    await scaffoldSandbox({
      workspacePath,
      sandboxName: 'test',
      sourceRepo,
      sourceRef: 'master',
      config: {
        role: 'Test',
        runtime: { type: 'docker-sandbox', launch: () => [] },
      },
    })

    const repoPath = join(workspacePath, 'sandboxes', 'test', 'repo')
    const seedRef = await git.revParse(repoPath, 'ao/seed')
    const head = await git.getCurrentRef(repoPath)
    expect(seedRef).toBe(head)
  })

  it('returns correct SandboxState', async () => {
    const state = await scaffoldSandbox({
      workspacePath,
      sandboxName: 'api',
      sourceRepo,
      sourceRef: 'master',
      config: {
        role: 'API developer',
        runtime: { type: 'openshell', launch: () => [] },
      },
    })

    expect(state.name).toBe('api')
    expect(state.status).toBe('idle')
    expect(state.runtimeType).toBe('openshell')
    expect(state.seedCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(state.createdAt).toBeTruthy()
  })

  it('writes idle status', async () => {
    await scaffoldSandbox({
      workspacePath,
      sandboxName: 'check',
      sourceRepo,
      sourceRef: 'master',
      config: {
        role: 'Checker',
        runtime: { type: 'docker-sandbox', launch: () => [] },
      },
    })

    const status = await readText(join(workspacePath, 'sandboxes', 'check', '.sandbox', 'status.md'))
    expect(status).toBe('idle')
  })

  it('generates CLAUDE.md with sandbox role and protocol', async () => {
    await scaffoldSandbox({
      workspacePath,
      sandboxName: 'reviewer',
      sourceRepo,
      sourceRef: 'master',
      config: {
        role: 'Code reviewer. Reviews PRs and provides feedback.',
        runtime: { type: 'docker-sandbox', launch: () => [] },
        receives: ['backend', 'frontend'],
      },
    })

    const claudeMd = await readText(join(workspacePath, 'sandboxes', 'reviewer', 'CLAUDE.md'))
    expect(claudeMd).toContain('reviewer')
    expect(claudeMd).toContain('Code reviewer')
    expect(claudeMd).toContain('assignment.md')
    expect(claudeMd).toContain('status.md')
    expect(claudeMd).toContain('ao/seed')
    expect(claudeMd).toContain('**backend**')
    expect(claudeMd).toContain('**frontend**')
  })
})
