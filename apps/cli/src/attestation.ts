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
 * `` `npm run ci` passed @ a1b2c3 — 646 tests green (self-reported) ``, or `"not run"` when the agent
 * recorded none. The headline speaks the CLI noun **check** — callers front this body with a `check`
 * label (`status`'s row) or a `check:` prefix (`merge`/`handoff`) — matching what `--check` sets. The
 * `(self-reported)` qualifier carries the one thing that must stay true: quimby only relays the agent's
 * own report, it never runs the check, so the wording is never "verified"/"validated" (which would
 * imply a quimby-run guarantee). Colorless — callers add any emphasis. When `liveHash` is given and
 * differs from the attested `atCommit`, the work changed since the agent reported, so it is flagged
 * stale, folded into the same parenthetical.
 */
export function formatAttestation(att: AgentAttestation | null, liveHash?: string | null): string {
  if (!att) return 'not run'
  const mark = att.result === 'pass' ? 'passed' : 'failed'
  const at = att.atCommit ? ` @ ${att.atCommit}` : ''
  const summary = att.summary ? ` — ${att.summary}` : ''
  const stale = isStale(att.atCommit, liveHash) ? '; STALE — agent changed since' : ''
  return `\`${att.command}\` ${mark}${at}${summary} (self-reported${stale})`
}

// Prefix-tolerant so a short attested hash (e.g. `a1b2c3d`) matches a full live one — stale only
// when both are present and neither is a prefix of the other.
function isStale(atCommit?: string, liveHash?: string | null): boolean {
  if (!atCommit || !liveHash) return false
  return !liveHash.startsWith(atCommit) && !atCommit.startsWith(liveHash)
}
