import { readdir, readFile, rename, rm } from 'node:fs/promises'

import {
  getAgentOutboxDir,
  getAgentOutboxDraftDir,
  getAgentOutboxSentDir,
  getAgentOutboxSentDraftDir,
  remoteAgentDir,
} from '@quimbyhq/paths'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { ensureDir, exists } from '@quimbyhq/utils'
import { join } from 'pathe'

/**
 * Move an SSH sender's delivered draft into the *remote* `.sent/` ledger, mirroring
 * {@link markHandoffSent} on the host side. Without this the remote draft lingers and
 * is re-picked-up by {@link pickupRemoteOutbox} on the next cycle, re-presenting as queued.
 * A no-op for local agents (their outbox is already the local filesystem).
 */
export async function clearRemoteOutboxDraft(
  agent: Readonly<AgentState>,
  projectId: string,
  recipient: string,
): Promise<void> {
  if (!isSSH(agent.location)) return
  const transport = getSSHTransport(agent.location)
  const outbox = `${remoteAgentDir(projectId, agent.id, agent.location.base)}/outbox`
  const draft = `${outbox}/${sq(recipient)}`
  const sent = `${outbox}/.sent/${sq(recipient)}`
  await transport.exec(`mkdir -p ${outbox}/.sent && rm -rf ${sent} && mv ${draft} ${sent}`)
}

/** Move a delivered outbox draft into the `.sent/` ledger (the progress record). */
export async function markHandoffSent(
  repoRoot: string,
  fromId: string,
  recipient: string,
): Promise<void> {
  const draft = getAgentOutboxDraftDir(repoRoot, fromId, recipient)
  if (!(await exists(draft))) return
  await ensureDir(getAgentOutboxSentDir(repoRoot, fromId))
  const sent = getAgentOutboxSentDraftDir(repoRoot, fromId, recipient)
  await rm(sent, { recursive: true, force: true })
  await rename(draft, sent)
}

/**
 * Pick up an SSH agent's remote outbox into its local outbox dir, so the rest of the
 * dispatch path (recipient listing, settle-debounce, note reading) can operate on the
 * local filesystem exactly as it does for a local agent. rsync's `-a` preserves the
 * remote mtimes, so the server's settle-debounce observes real stability across cycles.
 * A no-op for local agents, and for an SSH agent whose remote outbox does not yet exist.
 */
export async function pickupRemoteOutbox(
  repoRoot: string,
  agent: Readonly<AgentState>,
  projectId: string,
): Promise<void> {
  if (!isSSH(agent.location)) return
  const transport = getSSHTransport(agent.location)
  const remoteOutbox = `${remoteAgentDir(projectId, agent.id, agent.location.base)}/outbox`
  if (!(await transport.fileExists(remoteOutbox))) return
  const localOutbox = getAgentOutboxDir(repoRoot, agent.id)
  await ensureDir(localOutbox)
  await transport.rsyncFrom(remoteOutbox, localOutbox)
}

/** Read a recipient's queued outbox draft: its note and optional `attach:` code source. */
export async function readOutboxDraft(
  repoRoot: string,
  fromId: string,
  recipient: string,
): Promise<{ note: string; attach?: string }> {
  const readmePath = join(getAgentOutboxDraftDir(repoRoot, fromId, recipient), 'README.md')
  if (!(await exists(readmePath))) return { note: '' }
  return parseDraft(await readFile(readmePath, 'utf-8'))
}

/** List recipients with a queued outbox draft (local agents; ignores the `.sent/` ledger). */
export async function readOutboxRecipients(repoRoot: string, fromId: string): Promise<string[]> {
  const outboxDir = getAgentOutboxDir(repoRoot, fromId)
  if (!(await exists(outboxDir))) return []
  const entries = await readdir(outboxDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
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
