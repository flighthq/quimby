/**
 * What an automated nudge does when it lands on the pane a human is actively working in (§7):
 *
 * - `hold` (the default) — stand down rather than type over live keystrokes. The work is already
 *   durable in the inbox, so the agent picks it up on its next turn; the held nudge flashes the
 *   session's status line so the person it was held for can see it.
 * - `nudge` — type anyway. For a fleet you are watching but not conversing with, where a wake that
 *   waits for you to look away is a wake that never comes.
 *
 * Set it top-level for the workspace, or per agent/role. Like {@link NudgePolicy} the RECIPIENT's
 * setting governs, and `quimby sync` refreshes it onto agent state, so an edit reaches a live agent
 * without a rebuild.
 *
 * Deliberately SEPARATE from {@link NudgePolicy}, which decides *which parcels are worth waking an
 * agent for*. This decides *whether it is safe to type right now*. Two orthogonal gates: a parcel
 * must pass the nudge policy to get here at all, and folding them into one word is what made
 * `nudge: all` read as "wake me for everything, focus included" when it never meant that.
 *
 * The explicit `quimby nudge <agent>` forces past a `hold` regardless — that is the human choosing
 * to type into the session.
 */
export type FocusPolicy = 'hold' | 'nudge'
