/**
 * What an automated nudge does when it lands on the pane a human is actively working in (§7):
 *
 * - `directed` (the default) — derive it from the authority graph: an agent something DIRECTS is
 *   machine-driven, so a nudge types anyway; an agent nobody directs is the one you converse with,
 *   so it holds. This is the inverse-of-`directs` idiom escalation already uses, and it means a
 *   supervised fleet needs no per-agent config — watching a worker never stalls the loop, while the
 *   agent you actually talk to is still protected.
 * - `hold` — always stand down. The work is already durable in the inbox, so the agent picks it up
 *   on its next turn; the held nudge flashes the session's status line.
 * - `nudge` — always type, even into the agent you converse with.
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
 * "Actively working in" means *typing*, not *looking* — tmux reports a client's last input, so a
 * pane you are only watching stops counting as focused after `focusGrace`. The explicit
 * `quimby nudge <agent>` forces past a hold regardless.
 */
export type FocusPolicy = ResolvedFocusPolicy | 'directed'

/**
 * A focus policy with `directed` already collapsed against the authority graph — the concrete
 * hold-or-type decision the guard consumes. `@quimbyhq/session` sits below `@quimbyhq/workspace`,
 * so the graph lookup happens in the caller and only this reaches the guard.
 */
export type ResolvedFocusPolicy = 'hold' | 'nudge'
