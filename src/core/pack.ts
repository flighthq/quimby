import { readdir, readFile } from 'node:fs/promises'

import { join } from 'pathe'

import type { SSHLocation } from '../types/location'
import type { CommitMeta, PackMeta } from '../types/pack'
import { ConflictError, PackError, QuimbyError } from '../utils/errors'
import { ensureDir, exists, writeText } from '../utils/fs'
import { cp } from '../utils/fs'
import * as git from '../utils/git'
import {
  getPackDir,
  getPacksDir,
  getWorkerDir,
  getWorkerRepoDir,
  remotePackDir,
  remoteWorkerRepoDir,
} from '../utils/paths'
import { readYaml, writeYaml } from '../utils/yaml'
import { getSSHTransport } from './transport'

export async function createPack(opts: {
  repoRoot: string
  workerName: string
  packName?: string
  description?: string
  suggestedMessage?: string
}): Promise<PackMeta> {
  const { repoRoot, workerName } = opts
  const workerRepoDir = getWorkerRepoDir(repoRoot, workerName)

  const logOutput = await git.log(workerRepoDir, 'quimby/seed..HEAD', '%s')
  const subjects = logOutput.split('\n').filter(Boolean)

  if (subjects.length === 0) {
    throw new PackError('No commits since quimby/seed — nothing to pack')
  }

  const packName = opts.packName ?? (await nextPackName(repoRoot, workerName))
  const description = opts.description ?? subjects.join('; ')
  const suggestedMessage =
    opts.suggestedMessage ?? (subjects.length === 1 ? subjects[0] : subjects[subjects.length - 1])

  const packDir = getPackDir(repoRoot, packName)

  if (await exists(packDir)) {
    throw new PackError(`Pack "${packName}" already exists`)
  }

  const commitsDir = join(packDir, 'commits')
  await ensureDir(commitsDir)

  const patchFiles = await git.formatPatch(workerRepoDir, 'quimby/seed', commitsDir)

  const squashedDiff = await git.diff(workerRepoDir, 'quimby/seed')
  await writeText(join(packDir, 'squashed.diff'), squashedDiff)

  const fullLog = await git.log(workerRepoDir, 'quimby/seed..HEAD')
  const commits: CommitMeta[] = fullLog
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

  const meta: PackMeta = {
    name: packName,
    worker: workerName,
    description,
    suggestedMessage,
    createdAt: new Date().toISOString(),
    commits,
  }

  await writeYaml(join(packDir, 'meta.yaml'), meta)
  return meta
}

export async function listPacks(repoRoot: string): Promise<PackMeta[]> {
  const packsDir = getPacksDir(repoRoot)
  if (!(await exists(packsDir))) return []

  const entries = await readdir(packsDir, { withFileTypes: true })
  const packs: PackMeta[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const metaPath = join(packsDir, entry.name, 'meta.yaml')
    if (!(await exists(metaPath))) continue
    packs.push(await readYaml<PackMeta>(metaPath))
  }

  return packs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function readPack(
  repoRoot: string,
  packName: string,
): Promise<{ meta: PackMeta; squashedDiff: string }> {
  const packDir = getPackDir(repoRoot, packName)
  const metaPath = join(packDir, 'meta.yaml')

  if (!(await exists(metaPath))) {
    throw new PackError(`Pack "${packName}" not found`)
  }

  const meta = await readYaml<PackMeta>(metaPath)

  let squashedDiff = ''
  const diffPath = join(packDir, 'squashed.diff')
  if (await exists(diffPath)) {
    squashedDiff = await readFile(diffPath, 'utf-8')
  }

  return { meta, squashedDiff }
}

export type ApplyMode = 'squashed' | 'commits' | 'patch'

export async function applyPack(opts: {
  repoRoot: string
  packName: string
  targetRepoPath: string
  mode: ApplyMode
  branch?: boolean | string
  threeWay?: boolean
}): Promise<void> {
  const { repoRoot, packName, targetRepoPath, mode, branch, threeWay } = opts
  const packDir = getPackDir(repoRoot, packName)
  const { meta } = await readPack(repoRoot, packName)

  if (!(await git.isClean(targetRepoPath))) {
    throw new QuimbyError('Target repo has uncommitted changes. Commit or stash first.')
  }

  const previousRef = await git.getCurrentRef(targetRepoPath)
  let branchName: string | undefined

  if (branch !== undefined && branch !== false) {
    branchName = typeof branch === 'string' ? branch : `quimby/${meta.name}`
    if (await git.branchExists(targetRepoPath, branchName)) {
      await git.deleteBranch(targetRepoPath, branchName)
    }
    await git.createBranch(targetRepoPath, branchName)
  }

  try {
    switch (mode) {
      case 'squashed': {
        const diffPath = join(packDir, 'squashed.diff')
        if (threeWay) {
          const conflicts = await git.applyThreeWay(targetRepoPath, diffPath)
          if (conflicts.length > 0) {
            throw new ConflictError(
              `Pack "${packName}" applied with ${conflicts.length} conflict(s) — resolve then commit`,
              conflicts,
            )
          }
        } else {
          await git.apply(targetRepoPath, diffPath, { check: true })
          await git.apply(targetRepoPath, diffPath)
        }
        await git.addAll(targetRepoPath)
        await git.commit(targetRepoPath, meta.suggestedMessage)
        break
      }
      case 'commits': {
        const commitsDir = join(packDir, 'commits')
        const patches = await readdir(commitsDir)
        const sortedPatches = patches
          .filter((f) => f.endsWith('.patch'))
          .sort()
          .map((f) => join(commitsDir, f))
        await git.am(targetRepoPath, sortedPatches)
        break
      }
      case 'patch': {
        const diffPath = join(packDir, 'squashed.diff')
        await git.apply(targetRepoPath, diffPath)
        break
      }
    }
  } catch (err) {
    if (err instanceof ConflictError) throw err
    try {
      await git.amAbort(targetRepoPath)
    } catch {}
    if (branchName) {
      await git.checkout(targetRepoPath, previousRef)
      try {
        await git.deleteBranch(targetRepoPath, branchName)
      } catch {}
    }
    throw new QuimbyError(
      `Failed to apply pack "${packName}" in ${mode} mode: ${err instanceof Error ? err.message : err}`,
    )
  }
}

export async function sendPack(opts: {
  repoRoot: string
  packName: string
  workerName: string
}): Promise<void> {
  const { repoRoot, packName, workerName } = opts

  const packDir = getPackDir(repoRoot, packName)
  if (!(await exists(packDir))) {
    throw new PackError(`Pack "${packName}" not found`)
  }

  const workerDir = getWorkerDir(repoRoot, workerName)
  if (!(await exists(workerDir))) {
    throw new QuimbyError(`Worker "${workerName}" not found`)
  }

  const inboxDir = join(workerDir, 'inbox', 'packs', packName)
  await ensureDir(inboxDir)
  await cp(packDir, inboxDir, { recursive: true })
}

export async function createRemotePack(opts: {
  repoRoot: string
  workerName: string
  workerLocation: SSHLocation
  projectId: string
  packName?: string
  description?: string
  suggestedMessage?: string
}): Promise<PackMeta> {
  const { repoRoot, workerName, workerLocation, projectId } = opts
  const transport = getSSHTransport(workerLocation)
  const rRepoDir = remoteWorkerRepoDir(projectId, workerName, workerLocation.base)

  const logSubjects = await transport.exec(`git log quimby/seed..HEAD --format=%s`, {
    cwd: rRepoDir,
  })
  const subjects = logSubjects.split('\n').filter(Boolean)

  if (subjects.length === 0) {
    throw new PackError('No commits since quimby/seed — nothing to pack')
  }

  const packName = opts.packName ?? (await nextPackName(repoRoot, workerName))
  const description = opts.description ?? subjects.join('; ')
  const suggestedMessage =
    opts.suggestedMessage ?? (subjects.length === 1 ? subjects[0] : subjects[subjects.length - 1])

  const packDir = getPackDir(repoRoot, packName)
  if (await exists(packDir)) {
    throw new PackError(`Pack "${packName}" already exists`)
  }

  const commitsDir = join(packDir, 'commits')
  await ensureDir(commitsDir)

  // Run format-patch on remote into a temp dir, then rsync back.
  const rTmpDir = `/tmp/quimby-pack-${packName}`
  await transport.exec(`mkdir -p ${rTmpDir}`, { cwd: rRepoDir })
  await transport.exec(`git format-patch quimby/seed -o ${rTmpDir}`, { cwd: rRepoDir })
  await transport.rsyncFrom(rTmpDir, commitsDir)
  await transport.exec(`rm -rf ${rTmpDir}`)

  const squashedDiff = await transport.exec(`git diff quimby/seed`, { cwd: rRepoDir })
  await writeText(join(packDir, 'squashed.diff'), squashedDiff)

  const fullLog = await transport.exec(`git log quimby/seed..HEAD --format='%H|%s|%an|%aI'`, {
    cwd: rRepoDir,
  })
  const patchFiles = (await readdir(commitsDir)).filter((f) => f.endsWith('.patch')).sort()
  const commits: CommitMeta[] = fullLog
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      const [hash, message, author, date] = line.split('|')
      return { hash, message, author, date, patchFile: patchFiles[i] ?? '' }
    })

  const meta: PackMeta = {
    name: packName,
    worker: workerName,
    description,
    suggestedMessage,
    createdAt: new Date().toISOString(),
    commits,
  }

  await writeYaml(join(packDir, 'meta.yaml'), meta)

  // Also copy the pack to the remote packs dir so remote agents can reference it.
  const rPackDir = remotePackDir(projectId, packName, workerLocation.base)
  await transport.ensureDir(rPackDir)
  await transport.rsyncTo(packDir, rPackDir)

  return meta
}

async function nextPackName(repoRoot: string, workerName: string): Promise<string> {
  const packs = await listPacks(repoRoot)
  const prefix = `${workerName}-`
  let max = 0

  for (const pack of packs) {
    if (pack.name.startsWith(prefix)) {
      const suffix = pack.name.slice(prefix.length)
      const num = parseInt(suffix, 10)
      if (!isNaN(num) && num > max) max = num
    }
  }

  return `${workerName}-${max + 1}`
}
