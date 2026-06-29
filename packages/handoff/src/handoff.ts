import { createHash } from 'node:crypto'
import { readdir, readFile, rename, rm } from 'node:fs/promises'

import { ConflictError, HandoffError, QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import {
  getAgentDir,
  getAgentInboxParcelDir,
  getAgentOutboxDir,
  getAgentOutboxDraftDir,
  getAgentOutboxSentDir,
  getAgentOutboxSentDraftDir,
  getAgentRepoDir,
  getStagingHandoffDir,
  remoteAgentDir,
  remoteAgentRepoDir,
} from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import type { AgentLocation, CommitMeta, HandoffMeta, SSHLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { cp, ensureDir, exists, readYaml, writeText, writeYaml } from '@quimbyhq/utils'
import { join } from 'pathe'

export type ApplyMode = 'squashed' | 'commits' | 'patch'

/** Reserved sender name for a host → agent handoff (the host is not an agent). */
export const HOST_SENDER = 'host'

export async function applyHandoff(opts: {
  repoRoot: string
  name: string
  targetRepoPath: string
  mode: ApplyMode
  branch?: boolean | string
  threeWay?: boolean
}): Promise<void> {
  const { repoRoot, name, targetRepoPath, mode, branch, threeWay } = opts
  const dir = getStagingHandoffDir(repoRoot, name)
  const { meta } = await readHandoff(repoRoot, name)

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
        const diffPath = join(dir, 'squashed.diff')
        if (threeWay) {
          const conflicts = await git.applyThreeWay(targetRepoPath, diffPath)
          if (conflicts.length > 0) {
            throw new ConflictError(
              `Handoff "${name}" applied with ${conflicts.length} conflict(s) — resolve then commit`,
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
        const commitsDir = join(dir, 'commits')
        const sortedPatches = (await exists(commitsDir))
          ? (await readdir(commitsDir))
              .filter((f) => f.endsWith('.patch'))
              .sort()
              .map((f) => join(commitsDir, f))
          : []
        if (sortedPatches.length === 0) {
          // No committed history to replay (e.g. uncommitted-only work) — fall back
          // to the full squashed diff, applied to the working tree.
          await git.apply(targetRepoPath, join(dir, 'squashed.diff'))
          break
        }
        try {
          await git.am(targetRepoPath, sortedPatches)
        } catch (amErr) {
          // git am --3way stops at the first conflicting patch and leaves the am
          // session in progress. Surface the conflicts so the user can resolve
          // them and `git am --continue`, rather than aborting their work.
          const conflicts = await git.getConflicts(targetRepoPath)
          if (conflicts.length > 0) {
            throw new ConflictError(
              `Handoff "${name}" stopped with ${conflicts.length} conflict(s) — resolve then "git am --continue"`,
              conflicts,
            )
          }
          throw amErr
        }
        // The agent's uncommitted/untracked remainder rides on top as working-tree
        // changes (no commit) so `--commits` loses nothing.
        const remainderPath = join(dir, 'uncommitted.diff')
        if (await exists(remainderPath)) await git.apply(targetRepoPath, remainderPath)
        break
      }
      case 'patch': {
        const diffPath = join(dir, 'squashed.diff')
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
      `Failed to apply handoff "${name}" in ${mode} mode: ${err instanceof Error ? err.message : err}`,
    )
  }
}

/**
 * Assemble a parcel in the host staging area from a local code source's diff and/or a
 * note. Carries whichever halves exist — code-only, note-only, or both — and writes
 * `meta.yaml` last so a complete parcel is unambiguous. Throws when neither half exists.
 */
export async function assembleHandoff(opts: {
  repoRoot: string
  from: string
  codeSource?: string
  to?: string
  note?: string
  description?: string
  suggestedMessage?: string
  name?: string
}): Promise<HandoffMeta> {
  const { repoRoot, from } = opts
  const codeSource = opts.codeSource ?? from
  const repoDir = getAgentRepoDir(repoRoot, codeSource)

  const subjects = (await git.log(repoDir, 'quimby/seed..HEAD', '%s')).split('\n').filter(Boolean)
  // Full working-tree delta vs seed — committed + uncommitted + untracked, no commit made.
  const squashedDiff = await git.diffWorkingTree(repoDir, 'quimby/seed')
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
      const remainder = await git.diffWorkingTree(repoDir, 'HEAD')
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
 * into an agent. Sender is the reserved name `host`. No guard runs: the host is not
 * a guarded agent, and the recipient guards its own work when it later hands off.
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

  const squashedDiff = await git.diffWorkingTree(repoRoot, base)
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
  const rRepoDir = remoteAgentRepoDir(projectId, codeSource, codeSourceLocation.base)

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

/** Carry a staged parcel into a recipient agent's inbox (local copy or rsync). */
export async function deliverHandoff(opts: {
  repoRoot: string
  name: string
  to: string
  toLocation: Readonly<AgentLocation> | undefined
  projectId: string
}): Promise<void> {
  const { repoRoot, name, to, toLocation, projectId } = opts

  const stagingDir = getStagingHandoffDir(repoRoot, name)
  if (!(await exists(stagingDir))) {
    throw new HandoffError(`Handoff "${name}" not found`, name)
  }

  if (isSSH(toLocation)) {
    const transport = getSSHTransport(toLocation)
    const rInboxDir = `${remoteAgentDir(projectId, to, toLocation.base)}/inbox/${name}`
    await transport.ensureDir(rInboxDir)
    await transport.rsyncTo(stagingDir, rInboxDir)
    return
  }

  if (!(await exists(getAgentDir(repoRoot, to)))) {
    throw new QuimbyError(`Agent "${to}" not found`)
  }
  const inboxDir = getAgentInboxParcelDir(repoRoot, to, name)
  await ensureDir(inboxDir)
  await cp(stagingDir, inboxDir, { recursive: true })
}

/** Remove a staged parcel once it has been consumed (applied, delivered, exported). */
export async function discardHandoff(repoRoot: string, name: string): Promise<void> {
  await rm(getStagingHandoffDir(repoRoot, name), { recursive: true, force: true })
}

/** Move a delivered outbox draft into the `.sent/` ledger (the progress record). */
export async function markHandoffSent(
  repoRoot: string,
  from: string,
  recipient: string,
): Promise<void> {
  const draft = getAgentOutboxDraftDir(repoRoot, from, recipient)
  if (!(await exists(draft))) return
  await ensureDir(getAgentOutboxSentDir(repoRoot, from))
  const sent = getAgentOutboxSentDraftDir(repoRoot, from, recipient)
  await rm(sent, { recursive: true, force: true })
  await rename(draft, sent)
}

export async function readHandoff(
  repoRoot: string,
  name: string,
): Promise<{ meta: HandoffMeta; squashedDiff: string; note: string }> {
  const dir = getStagingHandoffDir(repoRoot, name)
  const metaPath = join(dir, 'meta.yaml')
  if (!(await exists(metaPath))) {
    throw new HandoffError(`Handoff "${name}" not found`, name)
  }
  const meta = await readYaml<HandoffMeta>(metaPath)
  const squashedDiff = (await exists(join(dir, 'squashed.diff')))
    ? await readFile(join(dir, 'squashed.diff'), 'utf-8')
    : ''
  const note = (await exists(join(dir, 'README.md')))
    ? await readFile(join(dir, 'README.md'), 'utf-8')
    : ''
  return { meta, squashedDiff, note }
}

/** Read a recipient's queued outbox draft: its note and optional `attach:` code source. */
export async function readOutboxDraft(
  repoRoot: string,
  from: string,
  recipient: string,
): Promise<{ note: string; attach?: string }> {
  const readmePath = join(getAgentOutboxDraftDir(repoRoot, from, recipient), 'README.md')
  if (!(await exists(readmePath))) return { note: '' }
  return parseDraft(await readFile(readmePath, 'utf-8'))
}

/** List recipients with a queued outbox draft (local agents; ignores the `.sent/` ledger). */
export async function readOutboxRecipients(repoRoot: string, from: string): Promise<string[]> {
  const outboxDir = getAgentOutboxDir(repoRoot, from)
  if (!(await exists(outboxDir))) return []
  const entries = await readdir(outboxDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
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
  const diff = await transport.exec(`git diff ${base} ${tree}`, { cwd: rRepoDir })
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

function parseDraft(content: string): { note: string; attach?: string } {
  if (!content.startsWith('---')) return { note: content }
  const end = content.indexOf('\n---', 3)
  if (end === -1) return { note: content }
  const frontmatter = content.slice(3, end)
  const note = content.slice(end + 4).replace(/^\r?\n/, '')
  const match = frontmatter.match(/^\s*attach:\s*(\S+)\s*$/m)
  return match ? { note, attach: match[1] } : { note }
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
