import { readdir, readFile, rename, rm } from 'node:fs/promises'

import {
  getAgentHandoffOutQueuedDir,
  getAgentHandoffOutQueuedRecipientDir,
  getAgentHandoffOutSentDir,
  getAgentHandoffOutSentRecipientDir,
  remoteAgentHandoffOutQueuedDir,
  remoteAgentHandoffOutSentDir,
} from '@quimbyhq/paths'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { cp, ensureDir, exists } from '@quimbyhq/utils'
import { join } from 'pathe'

/**
 * Move an SSH sender's delivered parcel from the *remote* `out/queued/` into `out/sent/`,
 * mirroring {@link markHandoffSent} on the host side. Without this the remote queued parcel
 * lingers and is re-picked-up by {@link pickupRemoteOutbox} on the next cycle, re-presenting as
 * queued. A no-op for local agents (their outbox is already the local filesystem).
 */
export async function clearRemoteOutboxDraft(
  agent: Readonly<AgentState>,
  projectId: string,
  recipient: string,
): Promise<void> {
  if (!isSSH(agent.location)) return
  const transport = getSSHTransport(agent.location)
  const queuedDir = remoteAgentHandoffOutQueuedDir(projectId, agent.id, agent.location.base)
  const sentDir = remoteAgentHandoffOutSentDir(projectId, agent.id, agent.location.base)
  const queued = `${queuedDir}/${sq(recipient)}`
  const sent = `${sentDir}/${sq(recipient)}`
  await transport.exec(`mkdir -p ${sentDir} && rm -rf ${sent} && mv ${queued} ${sent}`)
}

/**
 * Copy a queued parcel's extra files — everything the sender attached alongside the note via
 * `agent.sh handoff --file` — into `destDir` (the assembled staging parcel), returning the copied
 * basenames. The note (`README.md`) and the code source's diff are assembled separately; the
 * reserved parcel filenames are skipped so an attachment can never clobber the diff/manifest.
 * Without this, arbitrary files a sender staged are silently dropped on carry — the parcel shows
 * them in `out/queued`/`out/sent`, but they never reach the recipient's inbox. Directories are
 * ignored (`--file` only stages plain files). A no-op when the queue dir or extras are absent.
 */
export async function copyOutboxExtraFiles(
  repoRoot: string,
  fromId: string,
  recipient: string,
  destDir: string,
): Promise<string[]> {
  const queuedDir = getAgentHandoffOutQueuedRecipientDir(repoRoot, fromId, recipient)
  if (!(await exists(queuedDir))) return []
  const entries = await readdir(queuedDir, { withFileTypes: true })
  const extras = entries
    .filter((e) => e.isFile() && !RESERVED_PARCEL_FILES.has(e.name))
    .map((e) => e.name)
    .sort()
  if (extras.length === 0) return []
  await ensureDir(destDir)
  for (const name of extras) {
    await cp(join(queuedDir, name), join(destDir, name))
  }
  return extras
}

/** Move a delivered parcel from `out/queued/` into the `out/sent/` ledger (the progress record). */
export async function markHandoffSent(
  repoRoot: string,
  fromId: string,
  recipient: string,
): Promise<void> {
  const queued = getAgentHandoffOutQueuedRecipientDir(repoRoot, fromId, recipient)
  if (!(await exists(queued))) return
  await ensureDir(getAgentHandoffOutSentDir(repoRoot, fromId))
  const sent = getAgentHandoffOutSentRecipientDir(repoRoot, fromId, recipient)
  await rm(sent, { recursive: true, force: true })
  await rename(queued, sent)
}

/**
 * Pick up an SSH agent's remote `out/queued/` into its local queued dir, so the rest of the
 * dispatch path (recipient listing, settle-debounce, note reading) can operate on the
 * local filesystem exactly as it does for a local agent. rsync's `-a` preserves the
 * remote mtimes, so the server's settle-debounce observes real stability across cycles.
 * A no-op for local agents, and for an SSH agent whose remote queue does not yet exist.
 */
export async function pickupRemoteOutbox(
  repoRoot: string,
  agent: Readonly<AgentState>,
  projectId: string,
): Promise<void> {
  if (!isSSH(agent.location)) return
  const transport = getSSHTransport(agent.location)
  const remoteQueued = remoteAgentHandoffOutQueuedDir(projectId, agent.id, agent.location.base)
  if (!(await transport.fileExists(remoteQueued))) return
  const localQueued = getAgentHandoffOutQueuedDir(repoRoot, agent.id)
  await ensureDir(localQueued)
  await transport.rsyncFrom(remoteQueued, localQueued)
}

/** Read a recipient's queued parcel: its note and optional `attach:` code source. */
export async function readOutboxDraft(
  repoRoot: string,
  fromId: string,
  recipient: string,
): Promise<{ note: string; attach?: string }> {
  const readmePath = join(
    getAgentHandoffOutQueuedRecipientDir(repoRoot, fromId, recipient),
    'README.md',
  )
  if (!(await exists(readmePath))) return { note: '' }
  return parseDraft(await readFile(readmePath, 'utf-8'))
}

/** List recipients with a queued parcel in `out/queued/` (local agents). */
export async function readOutboxRecipients(repoRoot: string, fromId: string): Promise<string[]> {
  const queuedDir = getAgentHandoffOutQueuedDir(repoRoot, fromId)
  if (!(await exists(queuedDir))) return []
  const entries = await readdir(queuedDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

// Parcel filenames the assembler owns; a sender's `--file` attachment must never overwrite them.
// `README.md` is the note (assembled from the draft's frontmatter-stripped body separately).
const RESERVED_PARCEL_FILES = new Set([
  'README.md',
  'squashed.diff',
  'uncommitted.diff',
  'meta.yaml',
])

function parseDraft(content: string): { note: string; attach?: string } {
  if (!content.startsWith('---')) return { note: content }
  const end = content.indexOf('\n---', 3)
  if (end === -1) return { note: content }
  const frontmatter = content.slice(3, end)
  const note = content.slice(end + 4).replace(/^\r?\n/, '')
  const match = frontmatter.match(/^\s*attach:\s*(\S+)\s*$/m)
  return match ? { note, attach: match[1] } : { note }
}
