import { readdir } from 'node:fs/promises'

import { getAgentHandoffInReceivedDir } from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'

/**
 * Names of the unprocessed parcels in an agent's inbox — the delivered `<from>-<hash>`
 * directories under `handoff/in/received/`. Status mirrors (`status/`) and the processed
 * archive (`handoff/in/processed/`) are separate trees, so no filtering is needed. Sorted, and
 * empty when the received dir is absent. Local only (the twin of `readOutboxRecipients`); a
 * remote agent's inbox lives on its own host.
 */
export async function readInboxParcelNames(repoRoot: string, agentId: string): Promise<string[]> {
  const receivedDir = getAgentHandoffInReceivedDir(repoRoot, agentId)
  if (!(await exists(receivedDir))) return []
  const entries = await readdir(receivedDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}
