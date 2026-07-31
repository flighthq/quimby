import { getAgentStatusMirrorDir, remoteAgentStatusMirrorDir } from '@quimbyhq/paths'
import { getTransport, sq } from '@quimbyhq/transport'
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

/**
 * Mirror several peers' statuses into ONE recipient's `status/` dir in a single remote call.
 *
 * The fan-out is inherently N×N (every agent's status to every other agent), and delivering it one
 * file per round trip made an 8-agent SSH fleet spend ~16s of every 5s poll cycle on status alone —
 * overrunning the cycle and delaying the auto-dispatch that actually keeps the fleet moving. Batching
 * per recipient turns N² round trips into N.
 *
 * **The payload travels on stdin, never on the command line.** The command carries only the target
 * directory and a decode loop; each file arrives as a `<name> <base64>` line piped to the remote
 * shell. This is not merely tidier: a command line is echoed back in execa's error message, so an
 * earlier version that embedded the base64 in the command flooded `quimby serve` with tens of
 * thousands of characters the moment one delivery failed. Anything large belongs on stdin.
 *
 * Line framing is safe because base64 contains no spaces or newlines, and agent names are
 * roster-validated. Base64 (rather than raw bytes) keeps the framing intact for arbitrary status
 * prose — quotes, `$(…)`, backticks — none of which can escape into the shell from stdin.
 * `base64` is coreutils, already inside quimby's guaranteed remote floor (sh + git + coreutils).
 *
 * The directory guarantee is kept explicit rather than dropped: the command still opens with one
 * `mkdir -p`, in the SAME invocation as the writes, so there is no window where the dir could
 * vanish between them.
 */
export async function deliverStatusSnapshots(opts: {
  repoRoot: string
  stateId: string
  toAgent: Readonly<AgentState>
  snapshots: readonly Readonly<{ fromName: string; payload: string }>[]
}): Promise<void> {
  const { repoRoot, stateId, toAgent, snapshots } = opts
  if (snapshots.length === 0) return

  if (isSSH(toAgent.location)) {
    const transport = getTransport(toAgent.location)
    const dir = remoteAgentStatusMirrorDir(stateId, toAgent.id, toAgent.location.base)
    const input = snapshots
      .map(
        ({ fromName, payload }) =>
          `${fromName}.md ${Buffer.from(payload, 'utf-8').toString('base64')}\n`,
      )
      .join('')
    await transport.exec(
      `mkdir -p ${sq(dir)} && while IFS=' ' read -r qb_name qb_b64; do ` +
        `printf %s "$qb_b64" | base64 -d > ${sq(dir)}/"$qb_name" || exit 1; done`,
      { input },
    )
    return
  }

  // Local writes are plain fs calls, so batching buys nothing — but `writeFile` still creates the
  // parent, keeping both paths' directory guarantee identical.
  const statusMirrorDir = getAgentStatusMirrorDir(repoRoot, toAgent.id)
  await ensureDir(statusMirrorDir)
  for (const { fromName, payload } of snapshots) {
    await writeText(join(statusMirrorDir, `${fromName}.md`), payload)
  }
}
