import { getAgentStatusMirrorDir, remoteAgentStatusMirrorDir } from '@quimbyhq/paths'
import { getTransport } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { ensureDir, writeText } from '@quimbyhq/utils'
import { join } from 'pathe'

/**
 * Deliver a status snapshot from `fromName` into `toAgent`'s `status/<fromName>.md` mirror — the
 * same slot the poller writes when it mirrors status to every agent. Shared by the server's
 * automatic mirroring (on change) and the manual one-shot `quimby status <from> --to <agent>`, so
 * both land identically.
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
    const rStatusDir = remoteAgentStatusMirrorDir(stateId, toAgent.id, toAgent.location.base)
    await transport.ensureDir(rStatusDir)
    await transport.writeFile(`${rStatusDir}/${fromName}.md`, payload)
  } else {
    const statusMirrorDir = getAgentStatusMirrorDir(repoRoot, toAgent.id)
    await ensureDir(statusMirrorDir)
    await writeText(join(statusMirrorDir, `${fromName}.md`), payload)
  }
}
