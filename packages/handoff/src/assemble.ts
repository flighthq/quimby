import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { rm } from 'node:fs/promises'

import { HandoffError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getAgentRepoDir, getStagingHandoffDir, remoteAgentRepoDir } from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import type { CommitMeta, HandoffMeta, SSHLocation } from '@quimbyhq/types'
import { ensureDir, writeText, writeYaml } from '@quimbyhq/utils'
import { join } from 'pathe'

/** Reserved sender name for a host → agent handoff (the host is not an agent). */
export const HOST_SENDER = 'host'

/**
 * Assemble a parcel in the host staging area from a local code source's diff and/or a
 * note. Carries whichever halves exist — code-only, note-only, or both — and writes
 * `meta.yaml` last so a complete parcel is unambiguous. Throws when neither half exists.
 */
export async function assembleHandoff(opts: {
  repoRoot: string
  from: string
  codeSource?: string
  /** Stable id of the code-source agent — keys its on-disk repo directory. */
  codeSourceId: string
  to?: string
  note?: string
  description?: string
  suggestedMessage?: string
  name?: string
}): Promise<HandoffMeta> {
  const { repoRoot, from } = opts
  const codeSource = opts.codeSource ?? from
  const repoDir = getAgentRepoDir(repoRoot, opts.codeSourceId)

  const subjects = (await git.log(repoDir, 'quimby/seed..HEAD', '%s')).split('\n').filter(Boolean)
  // Full working-tree delta vs seed — committed + uncommitted + untracked, no commit made.
  const squashedDiff = await git.diffWorkingTree(repoDir, 'quimby/seed', { binary: true })
  const hasCode = squashedDiff.trim().length > 0
  if (!hasCode && !opts.note) {
    throw new HandoffError(`Nothing to hand off from "${from}" — no changes since seed and no note`)
  }

  const name = opts.name ?? parcelName(from, contentDigest([squashedDiff, opts.note ?? '']))
  const dir = getStagingHandoffDir(repoRoot, name)
  await rm(dir, { recursive: true, force: true })
  await ensureDir(dir)

  let commits: CommitMeta[] = []
  if (hasCode) {
    await writeText(join(dir, 'squashed.diff'), squashedDiff)
    if (subjects.length > 0) {
      // Committed history (for `apply --commits`), plus the uncommitted remainder so
      // that mode loses nothing of the working tree.
      const commitsDir = join(dir, 'commits')
      await ensureDir(commitsDir)
      const patchFiles = await git.formatPatch(repoDir, 'quimby/seed', commitsDir)
      commits = parseCommits(
        await git.log(repoDir, 'quimby/seed..HEAD'),
        patchFiles.map((p) => p.split('/').pop() ?? ''),
      )
      const remainder = await git.diffWorkingTree(repoDir, 'HEAD', { binary: true })
      if (remainder.trim()) await writeText(join(dir, 'uncommitted.diff'), remainder)
    }
  }
  if (opts.note) await writeText(join(dir, 'README.md'), opts.note)

  const meta = buildMeta({ ...opts, codeSource, name, subjects, commits })
  await writeYaml(join(dir, 'meta.yaml'), meta)
  return meta
}

/**
 * Assemble a parcel from the host's own working tree, for a host → agent handoff.
 * The diff is the host tree against the recipient's seed (what the recipient is
 * missing relative to its baseline), squashed — host commit history is not grafted
 * into an agent. Sender is the reserved name `host`.
 */
export async function assembleHostHandoff(opts: {
  repoRoot: string
  to: string
  base: string
  note?: string
  name?: string
}): Promise<HandoffMeta> {
  const { repoRoot, to } = opts

  // The recipient's seed should be a host commit; if it isn't reachable (the host
  // history was rewritten), fall back to HEAD so we carry just the uncommitted work.
  let base = opts.base
  try {
    await git.revParse(repoRoot, base)
  } catch {
    base = 'HEAD'
  }

  const squashedDiff = await git.diffWorkingTree(repoRoot, base, { binary: true })
  const hasCode = squashedDiff.trim().length > 0
  if (!hasCode && !opts.note) {
    throw new HandoffError(`Nothing to hand off from host — no changes vs "${to}" and no note`)
  }

  const name = opts.name ?? parcelName(HOST_SENDER, contentDigest([squashedDiff, opts.note ?? '']))
  const dir = getStagingHandoffDir(repoRoot, name)
  await rm(dir, { recursive: true, force: true })
  await ensureDir(dir)

  if (hasCode) await writeText(join(dir, 'squashed.diff'), squashedDiff)
  if (opts.note) await writeText(join(dir, 'README.md'), opts.note)

  const firstLine = (opts.note ?? '').split('\n').find(Boolean) ?? 'Work from host'
  const meta: HandoffMeta = {
    name,
    from: HOST_SENDER,
    to,
    note: opts.note,
    description: firstLine,
    suggestedMessage: firstLine,
    createdAt: new Date().toISOString(),
    commits: [],
  }
  await writeYaml(join(dir, 'meta.yaml'), meta)
  return meta
}

/** SSH counterpart of {@link assembleHandoff}: the code source is a remote agent. */
export async function assembleRemoteHandoff(opts: {
  repoRoot: string
  from: string
  codeSource?: string
  /** Stable id of the code-source agent — keys its remote repo directory. */
  codeSourceId: string
  codeSourceLocation: Readonly<SSHLocation>
  projectId: string
  to?: string
  note?: string
  description?: string
  suggestedMessage?: string
  name?: string
}): Promise<HandoffMeta> {
  const { repoRoot, from, codeSourceLocation, projectId } = opts
  const codeSource = opts.codeSource ?? from
  const transport = getSSHTransport(codeSourceLocation)
  const rRepoDir = remoteAgentRepoDir(projectId, opts.codeSourceId, codeSourceLocation.base)

  const subjects = (
    await transport.exec(`git log quimby/seed..HEAD --format=%s`, { cwd: rRepoDir })
  )
    .split('\n')
    .filter(Boolean)

  const squashedDiff = await remoteWorkingTreeDiff(transport, rRepoDir, 'quimby/seed')
  const hasCode = squashedDiff.trim().length > 0
  if (!hasCode && !opts.note) {
    throw new HandoffError(`Nothing to hand off from "${from}" — no changes since seed and no note`)
  }

  const name = opts.name ?? parcelName(from, contentDigest([squashedDiff, opts.note ?? '']))
  const dir = getStagingHandoffDir(repoRoot, name)
  await rm(dir, { recursive: true, force: true })
  await ensureDir(dir)

  let commits: CommitMeta[] = []
  if (hasCode) {
    await writeText(join(dir, 'squashed.diff'), squashedDiff)
    if (subjects.length > 0) {
      const commitsDir = join(dir, 'commits')
      await ensureDir(commitsDir)
      const rTmpDir = `/tmp/quimby-handoff-${name}`
      await transport.exec(`mkdir -p ${rTmpDir}`, { cwd: rRepoDir })
      await transport.exec(`git format-patch quimby/seed -o ${rTmpDir}`, { cwd: rRepoDir })
      await transport.rsyncFrom(rTmpDir, commitsDir)
      await transport.exec(`rm -rf ${rTmpDir}`)
      const fullLog = await transport.exec(`git log quimby/seed..HEAD --format='%H|%s|%an|%aI'`, {
        cwd: rRepoDir,
      })
      const patchFiles = (await readdir(commitsDir)).filter((f) => f.endsWith('.patch')).sort()
      commits = parseCommits(fullLog, patchFiles)
      const remainder = await remoteWorkingTreeDiff(transport, rRepoDir, 'HEAD')
      if (remainder.trim()) await writeText(join(dir, 'uncommitted.diff'), remainder)
    }
  }
  if (opts.note) await writeText(join(dir, 'README.md'), opts.note)

  const meta = buildMeta({ ...opts, codeSource, name, subjects, commits })
  await writeYaml(join(dir, 'meta.yaml'), meta)
  return meta
}

// A parcel's name is its origin and contents: <from>-<short-hash>, where the hash is
// over the parcel's payload (diff + note). Content-derived, so it needs no counter,
// dedupes identical sends, and reads back as "from whom".
function parcelName(from: string, hash: string): string {
  return `${from}-${hash.slice(0, 8)}`
}

function contentDigest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex')
}

// Capture a remote agent's full working tree (committed + uncommitted + untracked)
// vs `base` without making a commit — the SSH twin of git.diffWorkingTree. The
// GIT_INDEX_FILE prefix must stay on one &&-chained exec so it survives across the
// read-tree/add/write-tree steps (a fresh ssh shell per exec would lose it).
async function remoteWorkingTreeDiff(
  transport: ReturnType<typeof getSSHTransport>,
  rRepoDir: string,
  base: string,
): Promise<string> {
  const idx = `/tmp/quimby-idx-${crypto.randomUUID()}`
  const tree = (
    await transport.exec(
      `GIT_INDEX_FILE=${idx} git read-tree ${base} && GIT_INDEX_FILE=${idx} git add -A && GIT_INDEX_FILE=${idx} git write-tree`,
      { cwd: rRepoDir },
    )
  ).trim()
  const diff = await transport.exec(`git diff --binary ${base} ${tree}`, { cwd: rRepoDir })
  await transport.exec(`rm -f ${idx}`)
  return diff
}

function parseCommits(fullLog: string, patchFiles: readonly string[]): CommitMeta[] {
  return fullLog
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      const [hash, message, author, date] = line.split('|')
      return { hash, message, author, date, patchFile: patchFiles[i] ?? '' }
    })
}

function buildMeta(opts: {
  from: string
  codeSource: string
  to?: string
  note?: string
  name: string
  subjects: readonly string[]
  commits: CommitMeta[]
  description?: string
  suggestedMessage?: string
}): HandoffMeta {
  const { from, codeSource, subjects, note } = opts
  // Prefer the agent's own commit subjects; fall back to the note's first line; and
  // finally a generated default so `apply` always has a message and never prompts.
  const hasCommits = subjects.length > 0
  const firstLine = (note ?? '').split('\n').find(Boolean)
  const description =
    opts.description ?? (hasCommits ? subjects.join('; ') : (firstLine ?? `Work from ${from}`))
  const suggestedMessage =
    opts.suggestedMessage ??
    (hasCommits
      ? subjects.length === 1
        ? subjects[0]
        : subjects[subjects.length - 1]
      : (firstLine ?? `Apply work from ${from}`))
  return {
    name: opts.name,
    from,
    to: opts.to,
    codeSource: codeSource !== from ? codeSource : undefined,
    note,
    description,
    suggestedMessage,
    createdAt: new Date().toISOString(),
    commits: opts.commits,
  }
}
