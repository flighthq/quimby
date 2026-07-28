/**
 * When an automated nudge (assign / handoff / dispatch / auto-dispatch) declines to type into a
 * live session — coordination-proposals §7.
 *
 * - `focus` (default) — hold only when the agent's window is the one a human is actually looking
 *   at. A dashboard attaches a client per pane, so a session-wide check would hold every agent in
 *   a layout while the human is in exactly one of them.
 * - `always` — hold whenever any client is attached to the agent's session (the pre-focus rule).
 * - `never` — always inject; the human accepts that a nudge may land mid-keystroke.
 */
export type NudgeHoldPolicy = 'always' | 'focus' | 'never'
