import { readdir, readFile, rm } from 'node:fs/promises'

import { HandoffError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import {
  getAgentRepoDir,
  getStagingHandoffDir,
  QUIMBY_DIRNAME,
  remoteAgentRepoDir,
} from '@quimbyhq/paths'
import type { SSHTransport } from '@quimbyhq/transport'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentLocation, HandoffMeta, SSHLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { cp, ensureDir, exists, writeText, writeYaml } from '@quimbyhq/utils'
import { basename, join } from 'pathe'

import {
  assembleParcel,
  type AssembleParcelOptions,
  contentDigest,
  parcelName,
  type RepoAssembleOps,
} from './assembleParcel'
import { RESERVED_PARCEL_FILES } from './parcel'

/** Reserved sender name for a host → agent handoff (the host is not an agent). */
export const HOST_SENDER = 'host'

/**
 * Assemble a parcel from a local code source's diff and/or note (git CLI backend).
 */
export async function assembleHandoff(
  opts: AssembleParcelOptions & { codeSourceId: string },
): Promise<HandoffMeta> {
  return assembleParcel(opts, localAssembleOps(getAgentRepoDir(opts.repoRoot, opts.codeSourceId)))
}

/** SSH counterpart of {@link assembleHandoff}: the code source is a remote agent. */
export async function assembleRemoteHandoff(
  opts: AssembleParcelOptions & {
    codeSourceId: string
    codeSourceLocation: Readonly<SSHLocation>
    projectId: string
  },
): Promise<HandoffMeta> {
  const transport = getSSHTransport(opts.codeSourceLocation)
  const rRepoDir = remoteAgentRepoDir(
    opts.projectId,
    opts.codeSourceId,
    opts.codeSourceLocation.base,
  )
  return assembleParcel(opts, remoteAssembleOps(transport, rRepoDir))
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
  noteOnly?: boolean
  /** Host files to carry alongside the note/diff — see {@link resolveAttachments}. */
  files?: readonly string[]
}): Promise<HandoffMeta> {
  const { repoRoot, to } = opts
  const attachments = await resolveAttachments(opts.files ?? [])

  // The recipient's seed should be a host commit; if it isn't reachable (the host
  // history was rewritten), fall back to HEAD so we carry just the uncommitted work.
  let base = opts.base
  try {
    await git.revParse(repoRoot, base)
  } catch {
    base = 'HEAD'
  }

  const squashedDiff = opts.noteOnly
    ? ''
    : await git.diffWorkingTree(repoRoot, base, {
        binary: true,
        exclude: CAPTURE_EXCLUDE,
      })
  const hasCode = squashedDiff.trim().length > 0
  if (!hasCode && !opts.note && attachments.length === 0) {
    throw new HandoffError(
      `Nothing to hand off from host — no changes vs "${to}", no note, and no --file`,
    )
  }

  const name =
    opts.name ??
    parcelName(
      HOST_SENDER,
      // Attachments are part of the parcel's CONTENT, so they belong in its identity: two sends
      // differing only by attachment must be two parcels, and re-sending the same set must dedupe
      // to one, exactly as a re-sent diff does.
      contentDigest([
        squashedDiff,
        opts.note ?? '',
        opts.note ? 'user-directed' : 'ordinary',
        ...attachments.map((a) => `${a.name}\u0000${a.content}`),
      ]),
    )
  const dir = getStagingHandoffDir(repoRoot, name)
  await rm(dir, { recursive: true, force: true })
  await ensureDir(dir)

  if (hasCode) await writeText(join(dir, 'squashed.diff'), squashedDiff)
  if (opts.note) await writeText(join(dir, 'README.md'), opts.note)
  for (const attachment of attachments) await cp(attachment.path, join(dir, attachment.name))

  const firstLine = (opts.note ?? '').split('\n').find(Boolean) ?? 'Work from host'
  const meta: HandoffMeta = {
    name,
    from: HOST_SENDER,
    to,
    note: opts.note,
    userDirected: Boolean(opts.note) || undefined,
    description: firstLine,
    suggestedMessage: firstLine,
    createdAt: new Date().toISOString(),
    commits: [],
  }
  await writeYaml(join(dir, 'meta.yaml'), meta)
  return meta
}

/**
 * Validate `--file` attachments and read them for the content digest.
 *
 * Every problem here is a HARD error, unlike the agent-authored draft path, which skips a bad
 * attachment and reports it. The difference is who can still act: an agent's draft was written
 * earlier and unattended, so refusing the whole parcel would strand the note with it — but a host
 * `--file` was typed on the command line by someone standing right there, and failing before
 * anything is carried is both cheaper and clearer than delivering a parcel that quietly lacks the
 * one thing it was sent for.
 */
async function resolveAttachments(
  files: readonly string[],
): Promise<{ name: string; path: string; content: string }[]> {
  const seen = new Set<string>()
  const resolved: { name: string; path: string; content: string }[] = []
  for (const path of files) {
    const name = basename(path)
    if (RESERVED_PARCEL_FILES.has(name)) {
      throw new HandoffError(
        `Cannot attach "${path}": a parcel already uses the name "${name}" for its own ` +
          `${name === 'README.md' ? 'note' : name === 'meta.yaml' ? 'manifest' : 'diff'}. ` +
          'Rename the file and re-send.',
      )
    }
    if (seen.has(name)) {
      throw new HandoffError(
        `Cannot attach two files named "${name}" — a parcel is flat, so the second would ` +
          'overwrite the first. Rename one and re-send.',
      )
    }
    if (!(await exists(path))) throw new HandoffError(`Cannot attach "${path}": no such file`)
    let content: string
    try {
      content = await readFile(path, 'base64')
    } catch {
      // A directory reads as EISDIR. Parcels are flat by design, so this is a real refusal rather
      // than something to silently flatten or archive.
      throw new HandoffError(`Cannot attach "${path}": a parcel carries files, not directories`)
    }
    seen.add(name)
    resolved.push({ name, path, content })
  }
  return resolved
}

/**
 * Compute the parcel name an agent's *current* working tree would produce — the same
 * `<from>-<hash>` identity {@link assembleHandoff} assigns, but without staging anything.
 * Callers compare it to a previously-assembled parcel's name to tell whether the agent
 * has changed since (equal name ⇒ identical tree), e.g. to know a post-merge seed advance
 * would be lossless. The hash is note-less, matching a code-only parcel. Returns null when
 * the diff can't be captured — treat that as "unknown", not "unchanged".
 */
export async function getWorkingParcelName(opts: {
  repoRoot: string
  from: string
  /** Stable id of the agent whose working tree to hash — keys its repo directory. */
  codeSourceId: string
  location?: Readonly<AgentLocation>
  projectId: string
}): Promise<string | null> {
  try {
    if (isSSH(opts.location)) {
      const transport = getSSHTransport(opts.location)
      const rRepoDir = remoteAgentRepoDir(opts.projectId, opts.codeSourceId, opts.location.base)
      const diff = await remoteWorkingTreeDiff(transport, rRepoDir, 'quimby/seed')
      return parcelName(opts.from, contentDigest([diff, '', 'ordinary']))
    }
    const repoDir = getAgentRepoDir(opts.repoRoot, opts.codeSourceId)
    const diff = await git.diffWorkingTree(repoDir, 'quimby/seed', {
      binary: true,
      exclude: CAPTURE_EXCLUDE,
    })
    return parcelName(opts.from, contentDigest([diff, '', 'ordinary']))
  } catch {
    return null
  }
}

/** Assemble ops backed by the git CLI against a local agent clone. */
function localAssembleOps(repoDir: string): RepoAssembleOps {
  return {
    resolveSeed: () => git.revParse(repoDir, 'quimby/seed'),
    commitSubjects: async () =>
      (await git.log(repoDir, 'quimby/seed..HEAD', '%s')).split('\n').filter(Boolean),
    workingTreeDiff: (base) =>
      git.diffWorkingTree(repoDir, base, { binary: true, exclude: CAPTURE_EXCLUDE }),
    formatPatches: async (commitsDir) =>
      (await git.formatPatch(repoDir, 'quimby/seed', commitsDir)).map(
        (p) => p.split('/').pop() ?? '',
      ),
    fullCommitLog: () => git.log(repoDir, 'quimby/seed..HEAD'),
  }
}

/** Assemble ops backed by `git` over transport against an SSH agent's remote clone. */
function remoteAssembleOps(transport: SSHTransport, rRepoDir: string): RepoAssembleOps {
  const cwd = { cwd: rRepoDir }
  return {
    resolveSeed: async () => (await transport.exec(`git rev-parse quimby/seed`, cwd)).trim(),
    commitSubjects: async () =>
      (await transport.exec(`git log quimby/seed..HEAD --format=%s`, cwd))
        .split('\n')
        .filter(Boolean),
    workingTreeDiff: (base) => remoteWorkingTreeDiff(transport, rRepoDir, base),
    formatPatches: async (commitsDir) => {
      const rTmpDir = `/tmp/quimby-handoff-${crypto.randomUUID()}`
      const pathspecs = ['.', ...CAPTURE_EXCLUDE.map((p) => `:(exclude)${p}`)]
      await transport.exec(`mkdir -p ${rTmpDir}`, cwd)
      await transport.exec(
        `git format-patch quimby/seed -o ${rTmpDir} -- ${pathspecs.map(sq).join(' ')}`,
        cwd,
      )
      await transport.rsyncFrom(rTmpDir, commitsDir)
      await transport.exec(`rm -rf ${rTmpDir}`)
      return (await readdir(commitsDir)).filter((f) => f.endsWith('.patch')).sort()
    },
    fullCommitLog: () => transport.exec(`git log quimby/seed..HEAD --format='%H|%s|%an|%aI'`, cwd),
  }
}

// Capture a remote agent's full working tree (committed + uncommitted + untracked)
// vs `base` without making a commit — the SSH twin of git.diffWorkingTree. The
// GIT_INDEX_FILE prefix must stay on one &&-chained exec so it survives across the
// read-tree/add/write-tree steps (a fresh ssh shell per exec would lose it).
async function remoteWorkingTreeDiff(
  transport: SSHTransport,
  rRepoDir: string,
  base: string,
): Promise<string> {
  const idx = `/tmp/quimby-idx-${crypto.randomUUID()}`
  const ignored = `/tmp/quimby-ignored-${crypto.randomUUID()}`
  // Start from HEAD, then run bare `git add -A` in the throwaway index. The bare form lets Git
  // skip ignored loose files naturally, without the "Use -f if you really want to add them" error
  // explicit pathspecs trigger; committed files under ignored paths stay because HEAD is the base.
  // Then reset any tracked-but-loose changes that match gitignore back to HEAD, so ignored build
  // artifacts are carried only when they were truly committed.
  const g = `GIT_INDEX_FILE=${idx}`
  const excludeQuimby =
    `test -n "$(${g} git ls-tree ${base} -- ${QUIMBY_DIRNAME})" || ` +
    `${g} git rm -r --cached --quiet --ignore-unmatch -- ${QUIMBY_DIRNAME}`
  try {
    const tree = (
      await transport.exec(
        `${g} git read-tree HEAD && ` +
          `${g} git add -A && ` +
          `{ git diff --name-only -z HEAD | git check-ignore --no-index -z --stdin > ${ignored} || test $? -eq 1; } && ` +
          `{ test ! -s ${ignored} || ${g} git reset -q --pathspec-from-file=${ignored} --pathspec-file-nul HEAD; } && ` +
          `{ ${excludeQuimby}; } && ${g} git write-tree`,
        { cwd: rRepoDir },
      )
    ).trim()
    return await transport.exec(`git diff --binary ${base} ${tree}`, { cwd: rRepoDir })
  } finally {
    await transport.exec(`rm -f ${idx} ${ignored}`).catch(() => {})
  }
}

// Quimby's own state dir is never carried: excluded from every working-tree capture
// structurally, so a fresh project whose `.gitignore` lacks the entry can't leak
// `.quimby` into a handoff/apply.
const CAPTURE_EXCLUDE: readonly string[] = [QUIMBY_DIRNAME]
