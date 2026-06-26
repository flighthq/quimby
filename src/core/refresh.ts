import { join } from 'pathe'
import * as git from '../utils/git.js'
import { AoError } from '../utils/errors.js'
import { getSandboxRepoPath } from '../utils/paths.js'
import { logger } from '../utils/logger.js'
import type { SandboxState } from '../types/workspace.js'
import type { SandboxTransport } from './transport/types.js'

export interface RefreshResult {
  previousSeed: string
  newSeed: string
  hadUnbundledWork: boolean
  stashed: boolean
}

export async function refreshSandbox(opts: {
  workspacePath: string
  sandbox: SandboxState
  sourceRepo: string
  sourceRef: string
  transport: SandboxTransport
  force?: boolean
}): Promise<RefreshResult> {
  const { workspacePath, sandbox, sourceRepo, sourceRef, transport, force } = opts
  const repoPath = getSandboxRepoPath(workspacePath, sandbox.name)

  const isRemote = !!(sandbox.host && sandbox.user)

  let previousSeed: string
  let clean: boolean
  let hasUnbundled: boolean

  if (isRemote) {
    const seedResult = await transport.exec(
      ['git', 'rev-parse', 'ao/seed'],
      { cwd: 'repo' },
    )
    previousSeed = seedResult.stdout.trim()

    const statusResult = await transport.exec(
      ['git', 'status', '--porcelain'],
      { cwd: 'repo' },
    )
    clean = statusResult.stdout.trim() === ''

    const countResult = await transport.exec(
      ['git', 'rev-list', '--count', 'ao/seed..HEAD'],
      { cwd: 'repo' },
    )
    hasUnbundled = parseInt(countResult.stdout.trim(), 10) > 0
  } else {
    previousSeed = await git.getCurrentRef(repoPath)
    previousSeed = await git.revParse(repoPath, 'ao/seed')
    clean = await git.isClean(repoPath)
    hasUnbundled = await git.hasCommitsSince(repoPath, 'ao/seed')
  }

  if (!clean && !force) {
    throw new AoError(
      `Sandbox "${sandbox.name}" has uncommitted changes. ` +
      `Commit or stash first, or use --force.`,
    )
  }

  if (hasUnbundled && !force) {
    throw new AoError(
      `Sandbox "${sandbox.name}" has unbundled commits since ao/seed. ` +
      `Create a bundle first, or use --force to discard them.`,
    )
  }

  let stashed = false

  if (isRemote) {
    if (!clean) {
      await transport.exec(['git', 'stash', 'push', '-m', 'ao-refresh'], { cwd: 'repo' })
      stashed = true
    }

    const remoteUrl = await getAccessibleSourceUrl(sourceRepo, repoPath, isRemote, transport)

    const hasOrigin = await transport.exec(['git', 'remote', 'get-url', 'ao-source'], { cwd: 'repo' })
    if (hasOrigin.exitCode !== 0) {
      await transport.exec(['git', 'remote', 'add', 'ao-source', remoteUrl], { cwd: 'repo' })
    } else {
      await transport.exec(['git', 'remote', 'set-url', 'ao-source', remoteUrl], { cwd: 'repo' })
    }

    await transport.exec(['git', 'fetch', 'ao-source', sourceRef], { cwd: 'repo' })
    await transport.exec(['git', 'checkout', sourceRef], { cwd: 'repo' })
    await transport.exec(['git', 'reset', '--hard', `ao-source/${sourceRef}`], { cwd: 'repo' })
    await transport.exec(['git', 'tag', '-f', 'ao/seed'], { cwd: 'repo' })

    if (stashed) {
      logger.warn(
        `Sandbox "${sandbox.name}" had uncommitted changes that were stashed.`,
      )
    }
  } else {
    if (!clean) {
      stashed = await git.stash(repoPath)
    }

    if (!(await git.hasRemote(repoPath, 'ao-source'))) {
      await git.addRemote(repoPath, 'ao-source', sourceRepo)
    }

    await git.fetch(repoPath, 'ao-source', { ref: sourceRef })
    await git.checkout(repoPath, sourceRef)
    await git.resetHard(repoPath, `ao-source/${sourceRef}`)
    await git.tagForce(repoPath, 'ao/seed')

    if (stashed) {
      logger.warn(
        `Sandbox "${sandbox.name}" had uncommitted changes that were stashed. ` +
        `Use "git stash pop" in the sandbox repo to restore them.`,
      )
    }
  }

  let newSeed: string
  if (isRemote) {
    const result = await transport.exec(['git', 'rev-parse', 'HEAD'], { cwd: 'repo' })
    newSeed = result.stdout.trim()
  } else {
    newSeed = await git.getCurrentRef(repoPath)
  }

  return {
    previousSeed,
    newSeed,
    hadUnbundledWork: hasUnbundled,
    stashed,
  }
}

async function getAccessibleSourceUrl(
  sourceRepo: string,
  repoPath: string,
  isRemote: boolean,
  transport: SandboxTransport,
): Promise<string> {
  if (sourceRepo.startsWith('http') || sourceRepo.startsWith('git@') || sourceRepo.startsWith('ssh://')) {
    return sourceRepo
  }
  const remoteUrl = await git.getRemoteUrl(sourceRepo)
  if (remoteUrl) return remoteUrl
  if (isRemote) {
    throw new AoError(
      `Source repo "${sourceRepo}" is a local path with no remote URL. ` +
      `Remote sandboxes need an accessible URL. Push to a remote first.`,
    )
  }
  return sourceRepo
}
