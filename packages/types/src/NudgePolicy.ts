/**
 * When an automated nudge (assign / handoff / dispatch / auto-dispatch) may type into a live agent
 * session — coordination-proposals §7. A monotone scale, most permissive first:
 *
 * - `always` — always inject, even into the pane you are working in. Accepts that a nudge can land
 *   mid-keystroke.
 * - `unfocused` (the default) — inject unless the agent's window is the one you are working in. A
 *   dashboard attaches a client per pane, so anything coarser holds every agent in a layout while
 *   you type in exactly one of them.
 * - `never` — never inject. Parcels still arrive; the agent reads them on its own next turn.
 *
 * The explicit `quimby nudge <agent>` is the human deliberately typing, so it bypasses all three.
 */
export type NudgePolicy = 'always' | 'never' | 'unfocused'
