/**
 * Which delivered parcels wake an agent — coordination-proposals §6a/§7. Most permissive first:
 *
 * - `all` — every parcel that reaches this agent wakes it, advisory notes included. The "keep the
 *   fleet moving unattended" setting: work continues overnight without a human relaying.
 * - `directed` (the default) — only work the graph says is directed at it: a `directs` handoff, an
 *   honored escalation, or a reply to its own question. Routine peer chatter lands passively.
 * - `never` — nothing wakes it. Parcels still arrive; it reads them on its own next turn.
 *
 * Set it top-level for the workspace, or per agent/role (the RECIPIENT's setting governs — it is
 * that agent's tolerance for interruption). `always` and `focus` are accepted as legacy spellings
 * of `all` and `directed`.
 *
 * Orthogonal to this: quimby never types into the one pane a human is actively working in, whatever
 * the policy. That guard is about not clobbering live keystrokes, not about how much work interrupts
 * you — it holds exactly one window and releases the moment you look elsewhere. The explicit
 * `quimby nudge <agent>` forces past it.
 */
export type NudgePolicy = 'all' | 'directed' | 'never'
