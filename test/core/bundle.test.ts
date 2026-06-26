import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as git from '../../src/utils/git.js'
import {
  createBundle,
  listBundles,
  readBundle,
  applyBundle,
  createBundleViaTransport,
  listBundlesViaTransport,
} from '../../src/core/bundle.js'
import { LocalTransport } from '../../src/core/transport/local.js'

let tmp: string
let sandboxPath: string
let repoPath: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-bundle-test-'))
  sandboxPath = join(tmp, 'sandbox')
  repoPath = join(sandboxPath, 'repo')

  await mkdir(join(sandboxPath, '.sandbox', 'bundles'), { recursive: true })
  await mkdir(join(sandboxPath, '.sandbox', 'inbox'), { recursive: true })
  await mkdir(repoPath, { recursive: true })

  await git.init(repoPath)
  await writeFile(join(repoPath, 'file.txt'), 'initial')
  await git.addAll(repoPath)
  await git.commit(repoPath, 'initial commit')
  await git.tag(repoPath, 'ao/seed')
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('createBundle', () => {
  it('creates a bundle from sandbox commits', async () => {
    await writeFile(join(repoPath, 'new.txt'), 'added')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'add new file')

    const meta = await createBundle({
      sandboxPath,
      sandboxName: 'backend',
      bundleId: '001-add-feature',
      description: 'Added a new feature',
      suggestedMessage: 'feat: add new feature',
    })

    expect(meta.id).toBe('001-add-feature')
    expect(meta.sandbox).toBe('backend')
    expect(meta.commits).toHaveLength(1)
    expect(meta.commits[0].message).toBe('add new file')
  })

  it('writes meta.yaml last', async () => {
    await writeFile(join(repoPath, 'a.txt'), 'a')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'commit a')

    const meta = await createBundle({
      sandboxPath,
      sandboxName: 'test',
      bundleId: '002-test',
      description: 'test bundle',
      suggestedMessage: 'test',
    })

    const bundleDir = join(sandboxPath, '.sandbox', 'bundles', '002-test')
    const { exists } = await import('../../src/utils/fs.js')
    expect(await exists(join(bundleDir, 'meta.yaml'))).toBe(true)
    expect(await exists(join(bundleDir, 'squashed.diff'))).toBe(true)
    expect(await exists(join(bundleDir, 'commits'))).toBe(true)
  })
})

describe('createBundleViaTransport', () => {
  it('creates a bundle using transport interface', async () => {
    await writeFile(join(repoPath, 'transport.txt'), 'via transport')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'transport commit')

    const transport = new LocalTransport(sandboxPath)
    const meta = await createBundleViaTransport({
      transport,
      sandboxName: 'backend',
      bundleId: '003-transport',
      description: 'Transport bundle',
      suggestedMessage: 'feat: transport',
    })

    expect(meta.id).toBe('003-transport')
    expect(meta.commits).toHaveLength(1)
  })
})

describe('listBundles', () => {
  it('returns empty array when no bundles exist', async () => {
    const bundles = await listBundles(sandboxPath)
    expect(bundles).toEqual([])
  })

  it('lists created bundles sorted by date', async () => {
    await writeFile(join(repoPath, 'a.txt'), 'a')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'a')
    await createBundle({
      sandboxPath,
      sandboxName: 'test',
      bundleId: '001-first',
      description: 'first',
      suggestedMessage: 'first',
    })

    await writeFile(join(repoPath, 'b.txt'), 'b')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'b')
    await createBundle({
      sandboxPath,
      sandboxName: 'test',
      bundleId: '002-second',
      description: 'second',
      suggestedMessage: 'second',
    })

    const bundles = await listBundles(sandboxPath)
    expect(bundles).toHaveLength(2)
    expect(bundles[0].id).toBe('001-first')
    expect(bundles[1].id).toBe('002-second')
  })
})

describe('listBundlesViaTransport', () => {
  it('lists bundles using transport interface', async () => {
    await writeFile(join(repoPath, 'a.txt'), 'a')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'a')
    await createBundle({
      sandboxPath,
      sandboxName: 'test',
      bundleId: '001-first',
      description: 'first',
      suggestedMessage: 'first',
    })

    const transport = new LocalTransport(sandboxPath)
    const bundles = await listBundlesViaTransport(transport)
    expect(bundles).toHaveLength(1)
    expect(bundles[0].id).toBe('001-first')
  })
})

describe('readBundle', () => {
  it('reads bundle metadata and diff', async () => {
    await writeFile(join(repoPath, 'read.txt'), 'read me')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'add read')

    await createBundle({
      sandboxPath,
      sandboxName: 'test',
      bundleId: '001-read',
      description: 'readable',
      suggestedMessage: 'read this',
    })

    const bundlePath = join(sandboxPath, '.sandbox', 'bundles', '001-read')
    const { meta, squashedDiff } = await readBundle(bundlePath)
    expect(meta.id).toBe('001-read')
    expect(meta.description).toBe('readable')
    expect(squashedDiff).toContain('read.txt')
  })
})

describe('applyBundle', () => {
  let targetRepo: string

  beforeEach(async () => {
    targetRepo = join(tmp, 'target')
    await mkdir(targetRepo, { recursive: true })
    await git.init(targetRepo)
    await writeFile(join(targetRepo, 'file.txt'), 'initial')
    await git.addAll(targetRepo)
    await git.commit(targetRepo, 'initial')
  })

  it('applies a bundle in squashed mode', async () => {
    await writeFile(join(repoPath, 'feature.txt'), 'feature')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'add feature')

    await createBundle({
      sandboxPath,
      sandboxName: 'test',
      bundleId: '001-feat',
      description: 'Feature',
      suggestedMessage: 'feat: add feature',
    })

    const bundlePath = join(sandboxPath, '.sandbox', 'bundles', '001-feat')
    await applyBundle({ bundlePath, targetRepoPath: targetRepo, mode: 'squashed' })

    const { readFile: read } = await import('node:fs/promises')
    const content = await read(join(targetRepo, 'feature.txt'), 'utf-8')
    expect(content).toBe('feature')
  })

  it('applies a bundle in commits mode', async () => {
    await writeFile(join(repoPath, 'c1.txt'), 'c1')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'commit 1')

    await writeFile(join(repoPath, 'c2.txt'), 'c2')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'commit 2')

    await createBundle({
      sandboxPath,
      sandboxName: 'test',
      bundleId: '002-multi',
      description: 'Multi commit',
      suggestedMessage: 'multi',
    })

    const bundlePath = join(sandboxPath, '.sandbox', 'bundles', '002-multi')
    await applyBundle({ bundlePath, targetRepoPath: targetRepo, mode: 'commits' })

    const logOutput = await git.log(targetRepo, 'HEAD~2..HEAD')
    expect(logOutput).toContain('commit 1')
    expect(logOutput).toContain('commit 2')
  })

  it('applies a bundle in patch mode', async () => {
    await writeFile(join(repoPath, 'patch.txt'), 'patched')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'patch commit')

    await createBundle({
      sandboxPath,
      sandboxName: 'test',
      bundleId: '003-patch',
      description: 'Patch',
      suggestedMessage: 'patch',
    })

    const bundlePath = join(sandboxPath, '.sandbox', 'bundles', '003-patch')
    await applyBundle({ bundlePath, targetRepoPath: targetRepo, mode: 'patch' })

    expect(await git.isClean(targetRepo)).toBe(false)
  })

  it('throws when target repo is dirty', async () => {
    await writeFile(join(repoPath, 'a.txt'), 'a')
    await git.addAll(repoPath)
    await git.commit(repoPath, 'a')

    await createBundle({
      sandboxPath,
      sandboxName: 'test',
      bundleId: '004-dirty',
      description: 'd',
      suggestedMessage: 'd',
    })

    await writeFile(join(targetRepo, 'dirty.txt'), 'dirty')

    const bundlePath = join(sandboxPath, '.sandbox', 'bundles', '004-dirty')
    await expect(
      applyBundle({ bundlePath, targetRepoPath: targetRepo, mode: 'squashed' }),
    ).rejects.toThrow('uncommitted changes')
  })
})
