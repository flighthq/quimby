import type { QuimbyState } from '@quimbyhq/types'

/**
 * Add `target` to `subscriber`'s subscription list in place, returning whether the state
 * changed (false when already subscribed). Pure mutation of `state.subscriptions` — the
 * caller persists. Shared by the CLI `subscribe` command and the server's HTTP handler
 * so the dedup rule lives in one place.
 */
export function addSubscriptionToState(
  state: QuimbyState,
  subscriber: string,
  target: string,
): boolean {
  const subs = state.subscriptions ?? {}
  const targets = subs[subscriber] ?? []
  if (targets.includes(target)) return false
  targets.push(target)
  subs[subscriber] = targets
  state.subscriptions = subs
  return true
}

/**
 * Scrub every reference to agent `name` from `state.subscriptions` when it is removed: drop
 * its own subscriber entry, remove it as a target from every other subscriber's list, and
 * prune any list that empties as a result. Returns whether anything changed. Without this a
 * removed agent lingers in the map — the server would route to a ghost and `list` would print
 * a dead name. Pure mutation; the caller persists. Twin of {@link renameAgentInSubscriptions}.
 */
export function removeAgentFromSubscriptions(state: QuimbyState, name: string): boolean {
  const subs = state.subscriptions
  if (!subs) return false
  let changed = false
  if (Object.hasOwn(subs, name)) {
    delete subs[name]
    changed = true
  }
  for (const subscriber of Object.keys(subs)) {
    if (!subs[subscriber].includes(name)) continue
    const remaining = subs[subscriber].filter((t) => t !== name)
    if (remaining.length === 0) delete subs[subscriber]
    else subs[subscriber] = remaining
    changed = true
  }
  return changed
}

/**
 * Remove `target` from `subscriber`'s list in place, pruning the key when it empties, and
 * return whether the state changed (false when there was nothing to remove). Pure mutation
 * of `state.subscriptions`; the caller persists.
 */
export function removeSubscriptionFromState(
  state: QuimbyState,
  subscriber: string,
  target: string,
): boolean {
  const subs = state.subscriptions ?? {}
  if (!subs[subscriber] || !subs[subscriber].includes(target)) return false
  subs[subscriber] = subs[subscriber].filter((t) => t !== target)
  if (subs[subscriber].length === 0) delete subs[subscriber]
  state.subscriptions = subs
  return true
}

/**
 * Rewrite `state.subscriptions` when agent `oldName` is renamed to `newName`: move its own
 * subscriber entry to the new key, and replace it wherever it appears as a target in another
 * subscriber's list. Returns whether anything changed. Keeps the name-keyed map consistent
 * with a rename (which is otherwise a pure relabel). Pure mutation; the caller persists.
 * Twin of {@link removeAgentFromSubscriptions}.
 */
export function renameAgentInSubscriptions(
  state: QuimbyState,
  oldName: string,
  newName: string,
): boolean {
  const subs = state.subscriptions
  if (!subs) return false
  let changed = false
  if (Object.hasOwn(subs, oldName)) {
    subs[newName] = subs[oldName]
    delete subs[oldName]
    changed = true
  }
  // Runs after the key move, so a self-subscription carried under the new key is rewritten too.
  for (const subscriber of Object.keys(subs)) {
    const idx = subs[subscriber].indexOf(oldName)
    if (idx === -1) continue
    subs[subscriber][idx] = newName
    changed = true
  }
  return changed
}
