/**
 * The placeholder body written for a peer that exists in the roster but has no mirrored status
 * yet, so `ls status/` lists every current peer even before (or without) the poller. Deliberately
 * distinct from a real snapshot — no `Updated:` line — and reconcile writes it only when a peer's
 * file is absent, so it never clobbers real mirrored content.
 */
export function formatStatusPlaceholder(fromName: string): string {
  return `# Status: ${fromName}\n\n_No status reported yet._\n`
}

/** The status-snapshot payload written to a recipient's `status/<from>.md` mirror. */
export function formatStatusSnapshot(fromName: string, content: string, at: string): string {
  return `# Status: ${fromName}\n\nUpdated: ${at}\n\n${content}\n`
}
