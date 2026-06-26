import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as git from '../../src/utils/git.js'
import { exists, readText } from '../../src/utils/fs.js'
import { scaffoldSandbox } from '../../src/core/sandbox.js'
import { saveWorkspaceState, loadWorkspaceState } from '../../src/core/workspace.js'
import { createBundle, listBundles, readBundle, applyBundle } from '../../src/core/bundle.js'
import { sendBundle } from '../../src/core/inbox.js'
import { sendMessage, listMessages } from '../../src/core/messaging.js'
import { LocalTransport } from '../../src/core/transport/local.js'
import { writeText, ensureDir } from '../../src/utils/fs.js'
import type { WorkspaceState, SandboxState } from '../../src/types/workspace.js'

let tmp: string
let sourceRepo: string
let workspacePath: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-e2e-'))
  process.env.AO_HOME = join(tmp, 'ao-home')

  sourceRepo = join(tmp, 'source-repo')
  workspacePath = join(tmp, 'workspace')

  await mkdir(join(sourceRepo, 'src'), { recursive: true })
  await git.init(sourceRepo)
  await writeFile(join(sourceRepo, 'README.md'), '# Test Project\n')
  await writeFile(join(sourceRepo, 'src', 'index.ts'), 'export const version = 1\n')
  await git.addAll(sourceRepo)
  await git.commit(sourceRepo, 'initial commit')
})

afterEach(async () => {
  delete process.env.AO_HOME
  await rm(tmp, { recursive: true, force: true })
})

describe('full workflow: init → assign → bundle → apply', () => {
  it('scaffolds sandbox, simulates agent work, creates and applies a bundle', async () => {
    // 1. Scaffold a sandbox (what ao init does per-sandbox)
    const sandboxState = await scaffoldSandbox({
      workspacePath,
      sandboxName: 'backend',
      sourceRepo,
      sourceRef: 'master',
      config: {
        role: 'Backend engineer',
        runtime: { type: 'docker-sandbox', launch: () => ['echo', 'noop'] },
      },
    })

    expect(sandboxState.name).toBe('backend')
    expect(sandboxState.status).toBe('idle')

    const sandboxPath = join(workspacePath, 'sandboxes', 'backend')
    const repoPath = join(sandboxPath, 'repo')

    // Verify scaffold created the expected structure
    expect(await exists(join(sandboxPath, '.sandbox', 'bundles'))).toBe(true)
    expect(await exists(join(sandboxPath, '.sandbox', 'inbox'))).toBe(true)
    expect(await exists(join(sandboxPath, '.sandbox', 'messages'))).toBe(true)
    expect(await exists(join(sandboxPath, '.sandbox', 'assignment.md'))).toBe(true)
    expect(await exists(join(sandboxPath, '.sandbox', 'status.md'))).toBe(true)

    // Verify ao/seed tag exists
    const seedRef = await git.revParse(repoPath, 'ao/seed')
    const headRef = await git.revParse(repoPath, 'HEAD')
    expect(seedRef).toBe(headRef)

    // 2. Push an assignment (what ao sandbox assign does)
    await writeText(
      join(sandboxPath, '.sandbox', 'assignment.md'),
      '# Task\n\nAdd a utils module with a helper function.\n',
    )

    const assignment = await readText(join(sandboxPath, '.sandbox', 'assignment.md'))
    expect(assignment).toContain('utils module')

    // 3. Simulate agent work — make commits in the sandbox repo
    await writeFile(join(repoPath, 'src', 'utils.ts'), 'export function add(a: number, b: number) { return a + b }\n')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'feat: add utils module')

    await writeFile(join(repoPath, 'src', 'utils.test.ts'), 'import { add } from "./utils"\nconsole.assert(add(1, 2) === 3)\n')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'test: add utils tests')

    // Agent updates status
    await writeText(join(sandboxPath, '.sandbox', 'status.md'), 'done — added utils module with tests')

    // 4. Create a bundle (what ao bundle create does)
    const meta = await createBundle({
      sandboxPath,
      sandboxName: 'backend',
      bundleId: '001-add-utils',
      description: 'Added utils module with add helper and tests',
      suggestedMessage: 'feat: add utils module with helper and tests',
    })

    expect(meta.id).toBe('001-add-utils')
    expect(meta.sandbox).toBe('backend')
    expect(meta.commits).toHaveLength(2)
    expect(meta.commits[0].message).toBe('test: add utils tests')
    expect(meta.commits[1].message).toBe('feat: add utils module')

    // 5. List bundles
    const bundles = await listBundles(sandboxPath)
    expect(bundles).toHaveLength(1)
    expect(bundles[0].id).toBe('001-add-utils')

    // 6. Review bundle (read meta + diff)
    const bundlePath = join(sandboxPath, '.sandbox', 'bundles', '001-add-utils')
    const { meta: reviewMeta, squashedDiff } = await readBundle(bundlePath)
    expect(reviewMeta.description).toBe('Added utils module with add helper and tests')
    expect(squashedDiff).toContain('utils.ts')
    expect(squashedDiff).toContain('utils.test.ts')
    expect(squashedDiff).toContain('function add')

    // 7. Apply bundle to the source repo (squashed mode)
    await applyBundle({
      bundlePath,
      targetRepoPath: sourceRepo,
      mode: 'squashed',
    })

    // Verify the source repo has the changes
    const appliedUtils = await readFile(join(sourceRepo, 'src', 'utils.ts'), 'utf-8')
    expect(appliedUtils).toContain('function add')
    const appliedTests = await readFile(join(sourceRepo, 'src', 'utils.test.ts'), 'utf-8')
    expect(appliedTests).toContain('add(1, 2)')

    // Verify it's on the expected branch with a single squashed commit
    const logOutput = await git.log(sourceRepo, 'HEAD~1..HEAD')
    expect(logOutput).toContain('feat: add utils module with helper and tests')
  })

  it('applies bundle in commits mode preserving history', async () => {
    const sandboxState = await scaffoldSandbox({
      workspacePath,
      sandboxName: 'worker',
      sourceRepo,
      sourceRef: 'master',
      config: {
        role: 'Worker',
        runtime: { type: 'docker-sandbox', launch: () => ['echo', 'noop'] },
      },
    })

    const sandboxPath = join(workspacePath, 'sandboxes', 'worker')
    const repoPath = join(sandboxPath, 'repo')

    await writeFile(join(repoPath, 'docs.md'), '# Docs\n')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'docs: add documentation')

    await writeFile(join(repoPath, 'CHANGELOG.md'), '# Changelog\n')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'docs: add changelog')

    const meta = await createBundle({
      sandboxPath,
      sandboxName: 'worker',
      bundleId: '001-docs',
      description: 'Documentation',
      suggestedMessage: 'docs: add documentation and changelog',
    })

    const bundlePath = join(sandboxPath, '.sandbox', 'bundles', '001-docs')

    await applyBundle({
      bundlePath,
      targetRepoPath: sourceRepo,
      mode: 'commits',
    })

    // Both original commits should be preserved
    const logOutput = await git.log(sourceRepo, 'HEAD~2..HEAD')
    expect(logOutput).toContain('docs: add documentation')
    expect(logOutput).toContain('docs: add changelog')
  })

  it('applies bundle in patch mode without committing', async () => {
    await scaffoldSandbox({
      workspacePath,
      sandboxName: 'worker',
      sourceRepo,
      sourceRef: 'master',
      config: {
        role: 'Worker',
        runtime: { type: 'docker-sandbox', launch: () => ['echo', 'noop'] },
      },
    })

    const sandboxPath = join(workspacePath, 'sandboxes', 'worker')
    const repoPath = join(sandboxPath, 'repo')

    await writeFile(join(repoPath, 'new-file.txt'), 'hello\n')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'add file')

    await createBundle({
      sandboxPath,
      sandboxName: 'worker',
      bundleId: '001-patch',
      description: 'Patch test',
      suggestedMessage: 'add file',
    })

    const bundlePath = join(sandboxPath, '.sandbox', 'bundles', '001-patch')

    await applyBundle({
      bundlePath,
      targetRepoPath: sourceRepo,
      mode: 'patch',
    })

    // File should exist but repo should have uncommitted changes
    expect(await exists(join(sourceRepo, 'new-file.txt'))).toBe(true)
    expect(await git.isClean(sourceRepo)).toBe(false)
  })
})

describe('inter-sandbox communication', () => {
  it('sends a bundle from one sandbox to another via inbox', async () => {
    // Scaffold two sandboxes
    await scaffoldSandbox({
      workspacePath,
      sandboxName: 'backend',
      sourceRepo,
      sourceRef: 'master',
      config: {
        role: 'Backend',
        runtime: { type: 'docker-sandbox', launch: () => ['echo', 'noop'] },
      },
    })

    await scaffoldSandbox({
      workspacePath,
      sandboxName: 'frontend',
      sourceRepo,
      sourceRef: 'master',
      config: {
        role: 'Frontend',
        runtime: { type: 'docker-sandbox', launch: () => ['echo', 'noop'] },
        receives: ['backend'],
      },
    })

    // Backend does work and creates a bundle
    const backendRepo = join(workspacePath, 'sandboxes', 'backend', 'repo')
    await writeFile(join(backendRepo, 'api-types.ts'), 'export type User = { id: string }\n')
    await git.addAll(backendRepo)
    await git.commit(backendRepo, 'feat: add api types')

    await createBundle({
      sandboxPath: join(workspacePath, 'sandboxes', 'backend'),
      sandboxName: 'backend',
      bundleId: '001-api-types',
      description: 'API type definitions',
      suggestedMessage: 'feat: add api types',
    })

    // Route bundle from backend to frontend
    await sendBundle({
      workspacePath,
      fromSandbox: 'backend',
      toSandbox: 'frontend',
      bundleId: '001-api-types',
    })

    // Verify bundle landed in frontend's inbox
    const inboxMeta = join(
      workspacePath,
      'sandboxes', 'frontend',
      '.sandbox', 'inbox', 'from-backend', '001-api-types', 'meta.yaml',
    )
    expect(await exists(inboxMeta)).toBe(true)
  })

  it('sends messages between sandboxes', async () => {
    await scaffoldSandbox({
      workspacePath,
      sandboxName: 'backend',
      sourceRepo,
      sourceRef: 'master',
      config: {
        role: 'Backend',
        runtime: { type: 'docker-sandbox', launch: () => ['echo', 'noop'] },
      },
    })

    await scaffoldSandbox({
      workspacePath,
      sandboxName: 'reviewer',
      sourceRepo,
      sourceRef: 'master',
      config: {
        role: 'Reviewer',
        runtime: { type: 'docker-sandbox', launch: () => ['echo', 'noop'] },
      },
    })

    const backendPath = join(workspacePath, 'sandboxes', 'backend')
    const reviewerPath = join(workspacePath, 'sandboxes', 'reviewer')

    const backendTransport = new LocalTransport(backendPath)
    const reviewerTransport = new LocalTransport(reviewerPath)

    // Reviewer sends a question to backend
    const msg = await sendMessage({
      fromTransport: reviewerTransport,
      toTransport: backendTransport,
      from: 'reviewer',
      to: 'backend',
      type: 'question',
      subject: 'Auth strategy',
      body: 'Are you using JWT or session tokens for the auth layer?',
      priority: 'high',
    })

    expect(msg.id).toBe('001')
    expect(msg.type).toBe('question')
    expect(msg.priority).toBe('high')

    // Backend reads its messages
    const messages = await listMessages(backendTransport, { from: 'reviewer' })
    expect(messages).toHaveLength(1)
    expect(messages[0].subject).toBe('Auth strategy')
    expect(messages[0].body).toContain('JWT or session tokens')
  })
})
