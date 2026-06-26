import { join } from 'pathe'
import { readdir } from 'node:fs/promises'
import { ensureDir, exists, writeText } from '../utils/fs.js'
import { readYaml, writeYaml } from '../utils/yaml.js'
import * as git from '../utils/git.js'
import { AoError } from '../utils/errors.js'
import type { BundleMeta, CommitMeta } from '../types/bundle.js'
import type { SandboxTransport } from './transport/types.js'

export async function createBundle(opts: {
  sandboxPath: string
  sandboxName: string
  bundleId: string
  description: string
  suggestedMessage: string
}): Promise<BundleMeta> {
  const { sandboxPath, sandboxName, bundleId, description, suggestedMessage } =
    opts
  const repoPath = join(sandboxPath, 'repo')
  const bundleDir = join(sandboxPath, '.sandbox', 'bundles', bundleId)
  const commitsDir = join(bundleDir, 'commits')

  await ensureDir(commitsDir)

  const seedRef = 'ao/seed'

  const patchFiles = await git.formatPatch(repoPath, seedRef, commitsDir)

  const squashedDiff = await git.diff(repoPath, seedRef)
  await writeText(join(bundleDir, 'squashed.diff'), squashedDiff)

  const logOutput = await git.log(repoPath, `${seedRef}..HEAD`)
  const commits: CommitMeta[] = logOutput
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      const [hash, message, author, date] = line.split('|')
      return {
        hash,
        message,
        author,
        date,
        patchFile: patchFiles[i]?.split('/').pop() ?? '',
      }
    })

  const meta: BundleMeta = {
    id: bundleId,
    sandbox: sandboxName,
    description,
    suggestedMessage,
    createdAt: new Date().toISOString(),
    commits,
  }

  // meta.yaml is written last — signals completion to the watcher
  await writeYaml(join(bundleDir, 'meta.yaml'), meta)
  return meta
}

export async function createBundleViaTransport(opts: {
  transport: SandboxTransport
  sandboxName: string
  bundleId: string
  description: string
  suggestedMessage: string
}): Promise<BundleMeta> {
  const { transport, sandboxName, bundleId, description, suggestedMessage } = opts

  const bundleDir = `.sandbox/bundles/${bundleId}`
  const commitsDir = `${bundleDir}/commits`

  await transport.ensureDir(commitsDir)

  const seedRef = 'ao/seed'

  const patchResult = await transport.exec(
    ['git', 'format-patch', seedRef, '-o', commitsDir],
    { cwd: 'repo' },
  )
  const patchFiles = patchResult.stdout.split('\n').filter(Boolean)

  const diffResult = await transport.exec(
    ['git', 'diff', seedRef],
    { cwd: 'repo' },
  )
  await transport.pushFile(`${bundleDir}/squashed.diff`, diffResult.stdout)

  const logResult = await transport.exec(
    ['git', 'log', `${seedRef}..HEAD`, '--format=%H|%s|%an|%aI'],
    { cwd: 'repo' },
  )
  const commits: CommitMeta[] = logResult.stdout
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      const [hash, message, author, date] = line.split('|')
      return {
        hash,
        message,
        author,
        date,
        patchFile: patchFiles[i]?.split('/').pop() ?? '',
      }
    })

  const meta: BundleMeta = {
    id: bundleId,
    sandbox: sandboxName,
    description,
    suggestedMessage,
    createdAt: new Date().toISOString(),
    commits,
  }

  const { stringify } = await import('yaml')
  await transport.pushFile(
    `${bundleDir}/meta.yaml`,
    stringify(meta, { lineWidth: 0 }),
  )
  return meta
}

export async function listBundles(
  sandboxPath: string,
): Promise<BundleMeta[]> {
  const bundlesDir = join(sandboxPath, '.sandbox', 'bundles')
  if (!(await exists(bundlesDir))) return []

  const entries = await readdir(bundlesDir, { withFileTypes: true })
  const bundles: BundleMeta[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const metaPath = join(bundlesDir, entry.name, 'meta.yaml')
    if (!(await exists(metaPath))) continue
    bundles.push(await readYaml<BundleMeta>(metaPath))
  }

  return bundles.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function listBundlesViaTransport(
  transport: SandboxTransport,
): Promise<BundleMeta[]> {
  const bundlesDir = '.sandbox/bundles'
  if (!(await transport.exists(bundlesDir))) return []

  const entries = await transport.listDir(bundlesDir)
  const bundles: BundleMeta[] = []

  for (const entry of entries) {
    const metaPath = `${bundlesDir}/${entry}/meta.yaml`
    if (!(await transport.exists(metaPath))) continue
    const content = await transport.pullFile(metaPath)
    const { parse } = await import('yaml')
    bundles.push(parse(content) as BundleMeta)
  }

  return bundles.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function readBundle(
  bundlePath: string,
): Promise<{ meta: BundleMeta; squashedDiff: string }> {
  const meta = await readYaml<BundleMeta>(join(bundlePath, 'meta.yaml'))
  let squashedDiff = ''
  const diffPath = join(bundlePath, 'squashed.diff')
  if (await exists(diffPath)) {
    const { readFile } = await import('node:fs/promises')
    squashedDiff = await readFile(diffPath, 'utf-8')
  }
  return { meta, squashedDiff }
}

export type ApplyMode = 'squashed' | 'commits' | 'patch'

export async function applyBundle(opts: {
  bundlePath: string
  targetRepoPath: string
  mode: ApplyMode
}): Promise<void> {
  const { bundlePath, targetRepoPath, mode } = opts
  const { meta } = await readBundle(bundlePath)

  if (!(await git.isClean(targetRepoPath))) {
    throw new AoError(
      'Target repo has uncommitted changes. Commit or stash first.',
    )
  }

  const branchName = `ao/${meta.sandbox}/${meta.id}`
  await git.createBranch(targetRepoPath, branchName)

  try {
    switch (mode) {
      case 'squashed': {
        const diffPath = join(bundlePath, 'squashed.diff')
        await git.apply(targetRepoPath, diffPath, { check: true })
        await git.apply(targetRepoPath, diffPath)
        await git.addAll(targetRepoPath)
        await git.commit(targetRepoPath, meta.suggestedMessage)
        break
      }
      case 'commits': {
        const commitsDir = join(bundlePath, 'commits')
        const patches = await readdir(commitsDir)
        const sortedPatches = patches
          .filter((f) => f.endsWith('.patch'))
          .sort()
          .map((f) => join(commitsDir, f))
        await git.am(targetRepoPath, sortedPatches)
        break
      }
      case 'patch': {
        const diffPath = join(bundlePath, 'squashed.diff')
        await git.apply(targetRepoPath, diffPath)
        break
      }
    }
  } catch (err) {
    throw new AoError(
      `Failed to apply bundle "${meta.id}" in ${mode} mode: ${err instanceof Error ? err.message : err}`,
    )
  }
}
