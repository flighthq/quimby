import { stat } from 'node:fs/promises'

import { getAgentDir, getQuimbyDir, remoteAgentDir } from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { deliverStatusSnapshots, formatStatusSnapshot } from '@quimbyhq/status'
import { getTransport } from '@quimbyhq/transport'
import type { QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { exists, readText } from '@quimbyhq/utils'
import { loadState } from '@quimbyhq/workspace'
import { join } from 'pathe'

export interface StatusSnapshot {
  content: string
  mtime: number
}

/**
 * Read one agent's `status.md` and, if it changed since the last cycle, return the payload to
 * mirror. Pure detection — delivery is a separate phase so the whole cycle's changes can be
 * batched per recipient (see `mirrorStatusChanges`).
 *
 * Mirrors on first sighting too, not just on change: an agent that wrote a substantive status.md
 * before the server started (or the scaffold's initial `idle`) is seen exactly once as "new", and
 * swallowing that first sighting left peers with no status for it until it happened to change
 * again. The write is an idempotent overwrite, so re-mirroring the roster once on (re)start is
 * harmless.
 */
export async function readChangedStatus(
  repoRoot: string,
  state: QuimbyState,
  name: string,
  cache: Map<string, StatusSnapshot>,
): Promise<string | null> {
  const agent = state.agents[name]
  const previous = cache.get(name)
  let content: string

  if (isSSH(agent.location)) {
    // For SSH agents, fetch content and compare (no reliable mtime over SSH).
    const transport = getTransport(agent.location)
    const rAgentDir = remoteAgentDir(state.id, agent.id, agent.location.base)
    try {
      content = (await transport.readFile(`${rAgentDir}/status.md`)).trim()
    } catch {
      return null
    }
    if (previous && previous.content === content) return null
    cache.set(name, { content, mtime: 0 })
  } else {
    const statusPath = join(getAgentDir(repoRoot, agent.id), 'status.md')
    if (!(await exists(statusPath))) return null

    const mtime = await getFileMtime(statusPath)
    if (mtime === null) return null
    if (previous && previous.mtime === mtime) return null

    content = (await readText(statusPath)).trim()
    cache.set(name, { content, mtime })
  }

  return formatStatusSnapshot(name, content, new Date().toISOString())
}

/**
 * One poll cycle's status pass: read every agent's status concurrently, then mirror the changed
 * ones into every other agent — one batched call per recipient, recipients delivered concurrently.
 *
 * Both phases are parallel and the delivery is batched because this fan-out is N×N and was the
 * cycle's dominant cost: serialized, one file per round trip, an 8-agent SSH fleet spent ~16s of
 * every 5s cycle here, overrunning it and delaying the auto-dispatch that keeps the fleet moving.
 *
 * Reporting is one line per SOURCE agent rather than one per delivery. The old shape printed
 * `1 + (N-1)` lines per changed status — N² per cycle, 64 lines for 8 agents, reprinted in full on
 * every restart since first sighting also mirrors. A failed recipient is still named individually:
 * condensing the success path must not condense away the thing you need to see.
 */
export async function pollStatusCycle(
  repoRoot: string,
  state: QuimbyState,
  cache: Map<string, StatusSnapshot>,
  reporter: Reporter = silentReporter,
): Promise<void> {
  const names = Object.keys(state.agents)
  const read = await Promise.all(
    names.map(async (name) => ({
      name,
      // A failed read is already swallowed per agent inside readChangedStatus; this guard covers
      // an unexpected throw so one unreachable host never aborts the others' status pass.
      payload: await readChangedStatus(repoRoot, state, name, cache).catch(() => null),
    })),
  )
  const changed = read.filter((entry): entry is { name: string; payload: string } =>
    Boolean(entry.payload),
  )
  if (changed.length === 0) return

  // Mirror this cycle's changed statuses into every other agent's `status/` mirror — no
  // subscriptions. Availability is universal because it's near-free (status files are tiny), and it
  // removes the "forgot to subscribe" silent miss. Agents don't read the whole roster each cycle;
  // they peek at `status/<peer>.md` on demand (see the generated agent context), so wide
  // availability doesn't inflate any agent's context.
  const failures = new Map<string, string>()
  await Promise.all(
    names.map(async (recipient) => {
      const snapshots = changed
        .filter((entry) => entry.name !== recipient)
        .map((entry) => ({ fromName: entry.name, payload: entry.payload }))
      if (snapshots.length === 0) return
      try {
        await deliverStatusSnapshots({
          repoRoot,
          stateId: state.id,
          toAgent: state.agents[recipient],
          snapshots,
        })
      } catch (err) {
        failures.set(recipient, String(err))
      }
    }),
  )

  const peers = names.length - 1
  for (const { name } of changed) {
    const failed = [...failures.keys()].filter((r) => r !== name)
    if (failed.length === 0) {
      reporter.info(`[${name}] status → ${peers} peer(s)`)
    } else {
      reporter.warn(
        `[${name}] status → ${peers - failed.length}/${peers} peer(s); failed: ${failed
          .map((r) => `${r} (${failures.get(r)})`)
          .join(', ')}`,
      )
    }
  }
}

export async function reloadStateIfChanged(
  repoRoot: string,
  current: QuimbyState,
  lastMtime: number,
): Promise<QuimbyState> {
  const statePath = join(getQuimbyDir(repoRoot), 'state.yaml')
  const mtime = await getFileMtime(statePath)
  if (mtime !== null && mtime !== lastMtime) {
    return loadState(repoRoot)
  }
  return current
}

export async function getFileMtime(path: string): Promise<number | null> {
  try {
    const s = await stat(path)
    return s.mtimeMs
  } catch {
    return null
  }
}
