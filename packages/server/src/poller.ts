import { stat } from 'node:fs/promises'

import { getAgentDir, getQuimbyDir, remoteAgentDir } from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { deliverStatusSnapshot, formatStatusSnapshot } from '@quimbyhq/status'
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

export async function pollAgentStatus(
  repoRoot: string,
  state: QuimbyState,
  name: string,
  cache: Map<string, StatusSnapshot>,
  reporter: Reporter = silentReporter,
): Promise<void> {
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
      return
    }
    if (previous && previous.content === content) return
    cache.set(name, { content, mtime: 0 })
  } else {
    const statusPath = join(getAgentDir(repoRoot, agent.id), 'status.md')
    if (!(await exists(statusPath))) return

    const mtime = await getFileMtime(statusPath)
    if (mtime === null) return

    if (previous && previous.mtime === mtime) return

    content = (await readText(statusPath)).trim()
    cache.set(name, { content, mtime })
  }

  // Mirror on first sighting too, not just on change: an agent that wrote a substantive
  // status.md before the server started (or the scaffold's initial `idle`) is seen exactly
  // once as "new", and swallowing that first sighting left peers with no status for it until
  // it happened to change again. The write is an idempotent overwrite, so re-mirroring the
  // whole roster once on server (re)start is harmless.
  reporter.info(`[${name}] Status ${previous ? 'changed' : 'seen'}`)

  const statusPayload = formatStatusSnapshot(name, content, new Date().toISOString())

  // Mirror this agent's status into every other agent's `status/` mirror — no subscriptions.
  // Availability is universal because it's near-free (status files are tiny), and it removes the
  // "forgot to subscribe" silent miss. Agents don't read the whole roster each cycle; they peek at
  // `status/<peer>.md` on demand (see the generated agent context), so wide availability doesn't
  // inflate any agent's context. The human still sees every agent via `quimby status`.
  for (const [otherName, otherAgent] of Object.entries(state.agents)) {
    if (otherName === name) continue
    await deliverStatusSnapshot({
      repoRoot,
      stateId: state.id,
      fromName: name,
      toAgent: otherAgent,
      payload: statusPayload,
    })
    reporter.info(`  → mirrored to ${otherName}`)
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
