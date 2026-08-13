/**
 * Where an agent stands relative to the base, at the moment its status was snapshotted.
 *
 * This is the half of base staleness an agent cannot see for itself. `agent.sh` tells it when
 * `quimby/base` is ahead of *it*; nothing told it that a *peer* is ahead of the base — that the
 * peer holds work which exists only in that peer's clone. That gap is expensive in a way the
 * symmetric one is not: two agents independently fix the same defect, or a defect is reported in
 * airtight detail against code a peer repaired hours ago and has not yet landed.
 *
 * Only the host can compute it (agents cannot see each other), and the status mirror is the
 * channel already designed to carry ambient peer state — so it rides there rather than in a new
 * mechanism.
 */
export interface StatusPosition {
  /** Commits on the agent's branch since its seed — its unmerged history. */
  commits: number
  /** Changed files vs its seed: committed + uncommitted + untracked. */
  files: number
}

/**
 * The placeholder body written for a peer that exists in the roster but has no mirrored status
 * yet, so `ls status/` lists every current peer even before (or without) the poller. Deliberately
 * distinct from a real snapshot — no `Updated:` line — and reconcile writes it only when a peer's
 * file is absent, so it never clobbers real mirrored content.
 */
export function formatStatusPlaceholder(fromName: string): string {
  return `# Status: ${fromName}\n\n_No status reported yet._\n`
}

/**
 * The status-snapshot payload written to a recipient's `status/<from>.md` mirror.
 *
 * `position` is optional because it is not always knowable — an unreachable SSH host or an
 * unprovisioned repo yields nothing, and a snapshot with no position line is better than one
 * asserting a zero it did not measure. Omitting it is silence; `0` is a claim.
 */
export function formatStatusSnapshot(
  fromName: string,
  content: string,
  at: string,
  position?: Readonly<StatusPosition>,
): string {
  const header = position ? `Updated: ${at}\n${formatPosition(position)}` : `Updated: ${at}`
  return `# Status: ${fromName}\n\n${header}\n\n${content}\n`
}

// Stated in the reader's terms — "can I see this work?" — not the writer's. `none` is printed
// rather than omitted, because an absent line already means "not measured" and the two must not
// collapse into each other.
function formatPosition(position: Readonly<StatusPosition>): string {
  if (position.commits === 0 && position.files === 0) {
    return 'Unmerged: none — everything this agent has produced has landed on your base'
  }
  return (
    `Unmerged: ${position.commits} commit(s), ${position.files} file(s) — in this agent's clone ` +
    'only, not yet on your base'
  )
}
