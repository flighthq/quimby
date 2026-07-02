import { readdir } from 'node:fs/promises'

import { getAgentInboxDir } from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'

/**
 * Names of the unprocessed parcels in an agent's inbox — the delivered `<from>-<hash>`
 * directories, excluding the live `status/` mirror and the `.done/` archive. Sorted, and
 * empty when the inbox is absent. Local only (the twin of `readOutboxRecipients`); a remote
 * agent's inbox lives on its own host.
 */
export async function readInboxParcelNames(repoRoot: string, agentId: string): Promise<string[]> {
  const inboxDir = getAgentInboxDir(repoRoot, agentId)
  if (!(await exists(inboxDir))) return []
  const entries = await readdir(inboxDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'status' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}
