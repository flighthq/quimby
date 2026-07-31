import type { QuimbyState, ResolvedFocusPolicy } from '@quimbyhq/types'
import {
  getFocusGraceSeconds,
  loadQuimbyConfig,
  resolveAgentFocusPolicy,
} from '@quimbyhq/workspace'

/**
 * The §7 focus options for a nudge aimed at `recipient` — its resolved `whenFocused` (with the
 * `directed` default collapsed against the authority graph) and the configured `focusGrace`.
 *
 * Shared because every automated nudge site needs both halves and one config read: resolving the
 * policy without the grace, or loading config twice per nudge, is the kind of drift that leaves one
 * command honoring a setting the others ignore.
 */
export async function resolveNudgeFocusOptions(
  repoRoot: string,
  state: Readonly<QuimbyState>,
  recipient: string,
): Promise<{
  whenFocused: ResolvedFocusPolicy
  focusGraceSeconds: number
  projectId: string
}> {
  const config = await loadQuimbyConfig(repoRoot)
  return {
    whenFocused: resolveAgentFocusPolicy(config, state, recipient),
    focusGraceSeconds: getFocusGraceSeconds(config),
    // Scopes the guard's window-NAME match to this workspace's dashboard. The tmux socket is
    // shared machine-wide and agent names repeat across projects, so without it another
    // workspace's same-named pane holds this one.
    projectId: state.id,
  }
}
