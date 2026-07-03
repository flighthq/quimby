import { getAgentAttestation } from '@quimbyhq/agent'
import type { AgentAttestation, QuimbyState } from '@quimbyhq/types'

/**
 * A `resolveAttestation` callback for the handoff/dispatch/merge staging seam: reads a code
 * source agent's attestation to embed in the parcel `meta.yaml`. Returns null for the host or an
 * unknown name (neither has an agent status.md). Injected because `@quimbyhq/handoff` can't depend
 * on `@quimbyhq/agent`.
 */
export function attestationResolver(
  repoRoot: string,
  state: Readonly<QuimbyState>,
): (codeSourceName: string) => Promise<AgentAttestation | null> {
  return (codeSourceName) =>
    state.agents[codeSourceName]
      ? getAgentAttestation(repoRoot, state.id, state.agents[codeSourceName])
      : Promise.resolve(null)
}

/**
 * Render an agent's self-attestation as a one-line signal for `status`/`merge`/`handoff`:
 * `"attests: \`npm run ci\` PASSED @ a1b2c3 — 646 tests green"`, or `"unverified (no attestation)"`
 * when the agent recorded none. Deliberately says "attests", not "verified": it is the agent's own
 * report, relayed — never a quimby-run guarantee. Colorless — callers add any emphasis. When
 * `liveHash` is given and differs from the attested `atCommit`, the work changed since the agent
 * verified, so it is flagged stale.
 */
export function formatAttestation(att: AgentAttestation | null, liveHash?: string | null): string {
  if (!att) return 'unverified (no attestation)'
  const mark = att.result === 'pass' ? 'PASSED' : 'FAILED'
  const at = att.atCommit ? ` @ ${att.atCommit}` : ''
  const summary = att.summary ? ` — ${att.summary}` : ''
  const stale = isStale(att.atCommit, liveHash) ? ' (STALE — agent changed since)' : ''
  return `attests: \`${att.command}\` ${mark}${at}${summary}${stale}`
}

// Prefix-tolerant so a short attested hash (e.g. `a1b2c3d`) matches a full live one — stale only
// when both are present and neither is a prefix of the other.
function isStale(atCommit?: string, liveHash?: string | null): boolean {
  if (!atCommit || !liveHash) return false
  return !liveHash.startsWith(atCommit) && !atCommit.startsWith(liveHash)
}
