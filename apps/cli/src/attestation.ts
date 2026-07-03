import type { AgentAttestation } from '@quimbyhq/types'

/**
 * Render an agent's self-attestation as a one-line signal for `status`/`merge`/`handoff`:
 * `"attests: \`npm run ci\` PASSED @ a1b2c3 — 646 tests green"`, or `"unverified (no attestation)"`
 * when the agent recorded none. Deliberately says "attests", not "verified": it is the agent's own
 * report, relayed — never a quimby-run guarantee. Colorless — callers add any emphasis. When
 * `liveHash` is given and differs from the attested `atCommit`, the work changed since the agent
 * verified, so it is flagged stale.
 */
export function formatAttestation(att: AgentAttestation | null, liveHash?: string): string {
  if (!att) return 'unverified (no attestation)'
  const mark = att.result === 'pass' ? 'PASSED' : 'FAILED'
  const at = att.atCommit ? ` @ ${att.atCommit}` : ''
  const summary = att.summary ? ` — ${att.summary}` : ''
  const stale =
    liveHash && att.atCommit && liveHash !== att.atCommit ? ' (STALE — agent changed since)' : ''
  return `attests: \`${att.command}\` ${mark}${at}${summary}${stale}`
}
