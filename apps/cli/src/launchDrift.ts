import { launchFingerprint, resolveRuntimeSelection } from '@quimbyhq/launch'
import type { AgentState, QuimbyConfig, QuimbyState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { saveState } from '@quimbyhq/workspace'

interface LaunchFingerprintOpts {
  cmd?: string
  runtime?: string
  runtimeProfile?: string
}

// The launch command an agent's config resolves to *right now* — a fingerprint of the resolved
// runtime + entrypoint, so it tracks the actual command, not the role/profile name (a rename
// that resolves to the same command is not drift).
export function currentLaunchFingerprint(
  agent: Readonly<AgentState>,
  config: Readonly<QuimbyConfig>,
  opts: Readonly<LaunchFingerprintOpts> = {},
): string {
  return launchFingerprint(resolveRuntimeSelection({ agent, config, ...opts }))
}

/**
 * True when a live session should be recreated before reuse. Newer sessions record the exact
 * launch fingerprint; older sessions do not, so fall back to the agent's stored flattened
 * defaults. That catches role/profile edits such as a `review2` role now resolving to Codex
 * while the existing agent was created/launched from stale Claude defaults.
 */
export function hasLaunchDrifted(
  agent: Readonly<AgentState>,
  config: Readonly<QuimbyConfig>,
  opts: Readonly<LaunchFingerprintOpts> = {},
): boolean {
  return launchDrift(agent, config, opts) !== null
}

export function launchDrift(
  agent: Readonly<AgentState>,
  config: Readonly<QuimbyConfig>,
  opts: Readonly<LaunchFingerprintOpts> = {},
): { actual: string; desired: string } | null {
  const desired = currentLaunchFingerprint(agent, config, opts)
  const actual = agent.launchedWith ?? storedDefaultsLaunchFingerprint(agent, config)
  return actual === desired ? null : { actual, desired }
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
  opts: Readonly<LaunchFingerprintOpts> = {},
): void {
  const drift = launchDrift(agent, config, opts)
  if (drift) {
    logger.warn(
      `"${agent.name}" is running \`${drift.actual}\`, but its config now resolves to \`${drift.desired}\`. ` +
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
  opts: Readonly<LaunchFingerprintOpts> = {},
): Promise<void> {
  const fingerprint = currentLaunchFingerprint(state.agents[name], config, opts)
  if (state.agents[name].launchedWith !== fingerprint) {
    state.agents[name].launchedWith = fingerprint
    await saveState(repoRoot, state)
  }
}

function storedDefaultsLaunchFingerprint(
  agent: Readonly<AgentState>,
  config: Readonly<QuimbyConfig>,
): string {
  const storedAgent = {
    ...agent,
    // Avoid the same-named-role fallback used for desired launch resolution; this branch models
    // what older state would have launched from its persisted defaults.
    name: `__stored_defaults__${agent.name}`,
    role: undefined,
  }
  if (agent.defaults?.runtime || agent.defaults?.entrypoint) {
    return currentLaunchFingerprint(
      {
        ...storedAgent,
        defaults: {
          ...(agent.defaults.runtime ? { runtime: agent.defaults.runtime } : {}),
          ...(agent.defaults.entrypoint ? { entrypoint: agent.defaults.entrypoint } : {}),
        },
      },
      config,
    )
  }
  return currentLaunchFingerprint(storedAgent, config)
}
