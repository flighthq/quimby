import { launchFingerprint, resolveRuntimeSelection } from '@quimbyhq/launch'
import type { AgentState, QuimbyConfig, QuimbyState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { saveState } from '@quimbyhq/workspace'

// The launch command an agent's config resolves to *right now* — a fingerprint of the resolved
// runtime + entrypoint, so it tracks the actual command, not the role/profile name (a rename
// that resolves to the same command is not drift).
export function currentLaunchFingerprint(
  agent: Readonly<AgentState>,
  config: Readonly<QuimbyConfig>,
): string {
  return launchFingerprint(resolveRuntimeSelection({ agent, config }))
}

/**
 * Warn when a *running* agent's live session was launched with a command that differs from what
 * its config resolves to now — the session keeps its original command, so a config change only
 * takes effect on an explicit restart. Advisory only; never acts, so chat context is never lost
 * by surprise.
 */
export function warnIfLaunchDrifted(
  agent: Readonly<AgentState>,
  config: Readonly<QuimbyConfig>,
): void {
  const now = currentLaunchFingerprint(agent, config)
  if (agent.launchedWith && agent.launchedWith !== now) {
    logger.warn(
      `"${agent.name}" is running \`${agent.launchedWith}\`, but its config now resolves to \`${now}\`. ` +
        `Run \`quimby restart ${agent.name}\` to apply it — this resets the live session (it resumes from status.md).`,
    )
  }
}

/** Record the command a freshly-(re)created session was launched with, for later drift checks. */
export async function recordLaunchFingerprint(
  repoRoot: string,
  state: QuimbyState,
  name: string,
  config: Readonly<QuimbyConfig>,
): Promise<void> {
  const fingerprint = currentLaunchFingerprint(state.agents[name], config)
  if (state.agents[name].launchedWith !== fingerprint) {
    state.agents[name].launchedWith = fingerprint
    await saveState(repoRoot, state)
  }
}
