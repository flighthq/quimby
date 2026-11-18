import type { SandboxShellRunner } from '@quimbyhq/runtimes'
import {
  localSandboxShellRunner,
  sandboxRemoveCommand,
  sweepAgentSandboxes,
} from '@quimbyhq/runtimes'
import type { AgentState, QuimbyState } from '@quimbyhq/types'
import { isResolvedSSHLocation, isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { remoteSandboxShellRunner } from '@quimbyhq/workspace'

import { ensureAgentConnections } from './hostAlias'

/**
 * Remove every runtime sandbox (sbx/openshell) belonging to an agent, on the machine where it
 * lives — the host for a local agent, the SSH host for a remote one.
 *
 * Sandboxes are found by listing and matching the agent's `qb-<id[:8]>-` prefix rather than by
 * recomputing a name: the name hashes the entrypoint command, which teardown never knew, so the
 * old recomputed `rm` targeted a sandbox that did not exist — and an agent whose runtime came from
 * a role or profile was treated as `local` and skipped outright. Both failed silently, which is how
 * a host filled with sandboxes nobody had removed.
 *
 * Still never blocks removal: an unreachable host or a refused `rm` is reported, not thrown.
 */
export async function teardownAgentSandbox(opts: {
  agent: Readonly<AgentState>
  name: string
}): Promise<void> {
  const { agent, name } = opts
  let run: SandboxShellRunner
  let where = 'this machine'
  if (isSSH(agent.location)) {
    const location = agent.location
    where = `"${location.alias ?? location.host ?? '?'}"`
    if (!isResolvedSSHLocation(location)) {
      logger.warn(`Couldn't check for "${name}"'s sandbox — its host alias is unbound.`)
      return
    }
    run = remoteSandboxShellRunner(location)
  } else {
    run = localSandboxShellRunner()
  }
  try {
    const { removed, failed } = await sweepAgentSandboxes(run, [agent.id])
    for (const sandbox of removed) {
      logger.info(`Removed ${sandbox.cli} sandbox ${sandbox.name} on ${where}`)
    }
    if (failed.length > 0) {
      logger.warn(
        `Couldn't remove ${failed.length} sandbox(es) for "${name}" on ${where}: ` +
          failed.map((s) => `\`${sandboxRemoveCommand(s)}\``).join(', '),
      )
    }
  } catch (err) {
    logger.warn(
      `Couldn't check for "${name}"'s sandbox on ${where} (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — ` +
        'it may be left behind; `quimby storage clean-remote --sandboxes` finds orphans later.',
    )
  }
}

/**
 * Resolve an SSH agent's host alias in place before removing it, returning whether the host is
 * addressable. An alias that cannot be bound here (non-interactive, nothing configured) is reported
 * and answers false, so removal can still drop the agent from state — `remove` tolerates an
 * unreachable host by design, and an unbound one is the same situation from the user's side.
 */
export async function resolveForTeardown(
  repoRoot: string,
  state: Readonly<QuimbyState>,
  name: string,
): Promise<boolean> {
  try {
    await ensureAgentConnections(repoRoot, state, [name])
    return true
  } catch (err) {
    logger.warn(
      `Couldn't resolve "${name}"'s host: ${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
}
