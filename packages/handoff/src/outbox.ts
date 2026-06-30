import { readdir, readFile, rename, rm } from 'node:fs/promises'

import {
  getAgentOutboxDir,
  getAgentOutboxDraftDir,
  getAgentOutboxSentDir,
  getAgentOutboxSentDraftDir,
} from '@quimbyhq/paths'
import { ensureDir, exists } from '@quimbyhq/utils'
import { join } from 'pathe'

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
