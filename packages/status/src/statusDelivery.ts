import { rename } from 'node:fs/promises'

import { getAgentStatusMirrorDir, remoteAgentStatusMirrorDir } from '@quimbyhq/paths'
import { getTransport, sp } from '@quimbyhq/transport'
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
    await replaceMirrorFile(join(statusMirrorDir, `${fromName}.md`), payload)
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
    await transport.exec(renderRemoteStatusDelivery(dir), { input })
    return
  }

  // Local writes are plain fs calls, so batching buys nothing — but `writeFile` still creates the
  // parent, keeping both paths' directory guarantee identical.
  const statusMirrorDir = getAgentStatusMirrorDir(repoRoot, toAgent.id)
  await ensureDir(statusMirrorDir)
  for (const { fromName, payload } of snapshots) {
    await replaceMirrorFile(join(statusMirrorDir, `${fromName}.md`), payload)
  }
}

/**
 * The remote command that decodes one `<name> <base64>` line per file from stdin into `dir`.
 *
 * Extracted as a pure builder so the quoting can be pinned by a test, because getting it wrong is
 * SILENT: the remote path begins with `~/`, and `sq()` quotes the whole string, so `'~/...'` is
 * never expanded by the remote shell. `mkdir -p` then cheerfully creates a directory literally
 * named `~` under the SSH session's home, every write lands inside it, the command exits 0, and the
 * server reports `status → N peer(s)` — while not one byte reaches the agent. `sp()` leaves the
 * leading `~/` unquoted and quotes the rest, which is the whole difference.
 *
 * Verified against a real shell: with `sq()` the payload appeared at `$HOME/~/.quimby/...` and the
 * real mirror directory stayed empty.
 */
export function renderRemoteStatusDelivery(dir: string): string {
  const d = sp(dir)
  return (
    `mkdir -p ${d} && while IFS=' ' read -r qb_name qb_b64; do ` +
    `printf %s "$qb_b64" | base64 -d > ${d}/"$qb_name".tmp || exit 1; ` +
    `mv ${d}/"$qb_name".tmp ${d}/"$qb_name" || exit 1; done`
  )
}

/**
 * Replace a mirror file by writing a sibling temp file and renaming it over the target, rather than
 * rewriting it in place.
 *
 * The agent reading this file usually does so across a guest bind-mount (a sandbox, or virtiofs/9p),
 * and an in-place rewrite is the one update shape such a mount can miss: the dentry and inode are
 * unchanged, the PARENT DIRECTORY'S mtime does not move (verified — only a create/remove/rename
 * touches it), and a guest holding cached attributes has nothing telling it to revalidate. A rename
 * changes both the inode behind the name and the directory's mtime, which is the signal those caches
 * key on.
 *
 * It also makes the write atomic: a reader either sees the previous snapshot or the new one, never a
 * half-written file — which matters because the poller rewrites these every cycle while agents read
 * them at arbitrary moments.
 *
 * Note the inverse of the `handoff/` rule, and it is not a contradiction: there, quimby keeps tray
 * inodes STABLE because REPLACING a directory strands the guest on a dead one. Here it deliberately
 * replaces a file's inode, because KEEPING it is what lets a guest serve a stale copy. Directory
 * identity must persist; file contents must visibly turn over.
 */
async function replaceMirrorFile(path: string, payload: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeText(tmp, payload)
  await rename(tmp, path)
}
