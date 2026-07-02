import { getAgentInboxStatusDir, remoteAgentDir } from '@quimbyhq/paths'
import { getTransport } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { ensureDir, writeText } from '@quimbyhq/utils'
import { join } from 'pathe'

/** The status-snapshot payload written to a recipient's `inbox/status/<from>.md`. */
export function formatStatusSnapshot(fromName: string, content: string, at: string): string {
  return `# Status: ${fromName}\n\nUpdated: ${at}\n\n${content}\n`
}

/**
 * Deliver a status snapshot from `fromName` into `toAgent`'s `inbox/status/<fromName>.md` — the
 * same slot the poller writes for subscribers. Shared by the server's automatic routing (on
 * change) and the manual one-shot `quimby status <from> --to <agent>`, so both land identically.
 */
export async function deliverStatusSnapshot(opts: {
  repoRoot: string
  stateId: string
  fromName: string
  toAgent: Readonly<AgentState>
  payload: string
}): Promise<void> {
  const { repoRoot, stateId, fromName, toAgent, payload } = opts
  if (isSSH(toAgent.location)) {
    const transport = getTransport(toAgent.location)
    const rInboxStatusDir = `${remoteAgentDir(stateId, toAgent.id, toAgent.location.base)}/inbox/status`
    await transport.ensureDir(rInboxStatusDir)
    await transport.writeFile(`${rInboxStatusDir}/${fromName}.md`, payload)
  } else {
    const inboxStatusDir = getAgentInboxStatusDir(repoRoot, toAgent.id)
    await ensureDir(inboxStatusDir)
    await writeText(join(inboxStatusDir, `${fromName}.md`), payload)
  }
}
