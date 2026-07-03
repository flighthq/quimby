import * as git from '@quimbyhq/git'
import { getAgentDir, getAgentRepoDir, remoteAgentDir, remoteAgentRepoDir } from '@quimbyhq/paths'
import { getTransport } from '@quimbyhq/transport'
import type { AgentAttestation, AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { exists, readText } from '@quimbyhq/utils'
import { join } from 'pathe'

const ATTEST_BLOCK = /```quimby-attest[ \t]*\n([\s\S]*?)```/g

/**
 * Read an agent's latest attestation from its `status.md` (local or SSH), or `null` when the
 * file is unreadable or carries no `quimby-attest` block. Quimby only relays this — it never
 * runs the check.
 */
export async function getAgentAttestation(
  repoRoot: string,
  stateId: string,
  agent: Readonly<AgentState>,
): Promise<AgentAttestation | null> {
  const statusText = await readAgentStatus(repoRoot, stateId, agent)
  return statusText === null ? null : parseAttestation(statusText)
}

/**
 * The agent's `status.md` content (local or SSH), or `null` when it's absent/unreadable. The
 * agent's handoff to its own successor — read on a fresh launch to resume a crashed/reset session.
 */
export async function readAgentStatus(
  repoRoot: string,
  stateId: string,
  agent: Readonly<AgentState>,
): Promise<string | null> {
  try {
    if (isSSH(agent.location)) {
      const rAgentDir = remoteAgentDir(stateId, agent.id, agent.location.base)
      return await getTransport(agent.location).readFile(`${rAgentDir}/status.md`)
    }
    const path = join(getAgentDir(repoRoot, agent.id), 'status.md')
    return (await exists(path)) ? await readText(path) : null
  } catch {
    return null
  }
}

/**
 * The agent repo's current `HEAD` commit hash (or `null` if unreadable) — the "live" hash a
 * displayed attestation is checked against for staleness: if it no longer matches the block's
 * `atCommit`, the agent committed more work since it verified. (Detects new commits, not yet
 * uncommitted drift — the agent writes a commit hash, so that's what quimby can compare.)
 */
export async function getAgentHeadHash(
  repoRoot: string,
  stateId: string,
  agent: Readonly<AgentState>,
): Promise<string | null> {
  try {
    if (isSSH(agent.location)) {
      const rRepoDir = remoteAgentRepoDir(stateId, agent.id, agent.location.base)
      const out = await getTransport(agent.location).exec('git rev-parse HEAD', { cwd: rRepoDir })
      return out.trim() || null
    }
    return await git.revParse(getAgentRepoDir(repoRoot, agent.id), 'HEAD')
  } catch {
    return null
  }
}

/**
 * Parse the LAST `quimby-attest` fenced block from status.md text into an {@link AgentAttestation}.
 * The block is simple `key: value` lines (`command`, `result`, `summary`, `atCommit`). Returns
 * `null` when there is no block, or `command`/`result` is missing or `result` isn't pass|fail —
 * a malformed self-report is treated as no attestation rather than trusted.
 */
export function parseAttestation(statusText: string): AgentAttestation | null {
  let body: string | undefined
  for (const m of statusText.matchAll(ATTEST_BLOCK)) body = m[1] // last block wins (most recent)
  if (body === undefined) return null

  const fields: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line)
    if (m) fields[m[1].toLowerCase()] = m[2]
  }

  const command = fields.command
  // `result` is an enum, so take only its first whitespace-delimited token — a stray trailing
  // comment (`pass  # pass | fail`) must not nuke the whole attestation. `command`/`summary` stay
  // free-text (they can legitimately contain `#`, e.g. `summary: fixes #123`).
  const result = fields.result?.split(/\s+/)[0]
  if (!command || (result !== 'pass' && result !== 'fail')) return null
  return {
    command,
    result,
    ...(fields.summary ? { summary: fields.summary } : {}),
    ...(fields.atcommit ? { atCommit: fields.atcommit } : {}),
  }
}
