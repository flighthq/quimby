import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'

import { HandoffError } from '@quimbyhq/errors'
import { getStagingHandoffDir } from '@quimbyhq/paths'
import type { AgentAttestation, CommitMeta, HandoffMeta } from '@quimbyhq/types'
import { ensureDir, writeText, writeYaml } from '@quimbyhq/utils'
import { join } from 'pathe'

/**
 * The git reads a parcel assembly needs from a code source, abstracted over the backend
 * so the same assembly drives a local agent (git CLI) and an SSH agent (git over
 * transport). Adapters are thin forwarders; the assembly logic lives once in
 * {@link assembleParcel} and is testable against a fake implementation.
 */
export interface RepoAssembleOps {
  /** The `quimby/seed` commit hash. */
  resolveSeed(): Promise<string>
  /** Subjects of the agent's commits past seed (`quimby/seed..HEAD`, newest first). */
  commitSubjects(): Promise<string[]>
  /** Full working-tree diff (committed + uncommitted + untracked) vs `base`, binary-safe. */
  workingTreeDiff(base: string): Promise<string>
  /** Write the agent's commits as patches into `commitsDir`; return their basenames, sorted. */
  formatPatches(commitsDir: string): Promise<string[]>
  /** `git log quimby/seed..HEAD` in the `%H|%s|%an|%aI` shape {@link parseCommits} expects. */
  fullCommitLog(): Promise<string>
}

export interface AssembleParcelOptions {
  repoRoot: string
  from: string
  codeSource?: string
  to?: string
  note?: string
  userDirected?: boolean
  description?: string
  suggestedMessage?: string
  name?: string
  /**
   * Resolve the code source's self-attestation to embed in `meta.yaml`, so it travels with the
   * parcel. A callback (not a value) because the attestation is read from the agent's status.md by
   * `@quimbyhq/agent`, which this package cannot depend on; the caller injects the reader.
   */
  resolveAttestation?: (codeSourceName: string) => Promise<AgentAttestation | null | undefined>
}

/**
 * Assemble a parcel in the host staging area from an agent code source's diff and/or a
 * note. Carries whichever halves exist — code-only, note-only, or both — writes the
 * committed history as patches plus the uncommitted remainder (so `apply --commits`
 * loses nothing), and writes `meta.yaml` last so a complete parcel is unambiguous.
 * Throws when neither a diff nor a note exists. Backend-agnostic via {@link RepoAssembleOps}.
 */
export async function assembleParcel(
  opts: Readonly<AssembleParcelOptions>,
  ops: RepoAssembleOps,
): Promise<HandoffMeta> {
  const { repoRoot, from } = opts
  const codeSource = opts.codeSource ?? from

  const seedCommit = await ops.resolveSeed()
  const subjects = await ops.commitSubjects()
  const squashedDiff = await ops.workingTreeDiff('quimby/seed')
  const hasCode = squashedDiff.trim().length > 0
  if (!hasCode && !opts.note) {
    throw new HandoffError(`Nothing to hand off from "${from}" — no changes since seed and no note`)
  }

  const name =
    opts.name ??
    parcelName(
      from,
      contentDigest([
        squashedDiff,
        opts.note ?? '',
        opts.userDirected ? 'user-directed' : 'ordinary',
      ]),
    )
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
      const patchFiles = await ops.formatPatches(commitsDir)
      commits = parseCommits(await ops.fullCommitLog(), patchFiles)
      const remainder = await ops.workingTreeDiff('HEAD')
      if (remainder.trim()) await writeText(join(dir, 'uncommitted.diff'), remainder)
    }
  }
  if (opts.note) await writeText(join(dir, 'README.md'), opts.note)

  const attestation = (await opts.resolveAttestation?.(codeSource)) ?? undefined
  const meta = buildMeta({ ...opts, codeSource, name, seedCommit, subjects, commits, attestation })
  await writeYaml(join(dir, 'meta.yaml'), meta)
  return meta
}

/**
 * A parcel's name is its origin and contents: `<from>-<short-hash>`, where the hash is
 * over the payload (diff + note + authority class) — content-derived, so it needs no counter, dedupes
 * identical sends, and reads back as "from whom".
 */
export function parcelName(from: string, hash: string): string {
  return `${from}-${hash.slice(0, 8)}`
}

export function contentDigest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex')
}

export function parseCommits(fullLog: string, patchFiles: readonly string[]): CommitMeta[] {
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
  userDirected?: boolean
  name: string
  seedCommit?: string
  subjects: readonly string[]
  commits: CommitMeta[]
  description?: string
  suggestedMessage?: string
  attestation?: AgentAttestation
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
    seedCommit: opts.seedCommit,
    note,
    userDirected: opts.userDirected || undefined,
    description,
    suggestedMessage,
    createdAt: new Date().toISOString(),
    commits: opts.commits,
    attestation: opts.attestation,
  }
}
