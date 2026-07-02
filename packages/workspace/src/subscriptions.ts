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
