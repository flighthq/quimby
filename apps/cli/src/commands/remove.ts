import { removeAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { quimbyTmuxSocket, tmuxSessionName } from '@quimbyhq/paths'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import {
  loadState,
  removeAgentFromSubscriptions,
  resolveWorkspace,
  saveState,
} from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

export default defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove an agent',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent name',
      required: true,
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Confirm removal (for an SSH agent, also skips remote cleanup)',
      default: false,
    },
  },
  run: runRemoveCommand,
})

export async function runRemoveCommand({ args }: { args: { agent: string; force: boolean } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.agent]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }

  // Removal is destructive, so gate it behind --force just like `rebuild`. For an SSH agent
  // --force keeps its second duty of skipping remote cleanup, so the warning names that too.
  if (!args.force) {
    const remoteNote = isSSH(agent.location)
      ? ' Its remote workspace is left in place (a forced removal skips remote cleanup).'
      : ''
    logger.warn(
      `This permanently removes "${args.agent}" — its repo, work, inbox, and outbox.${remoteNote} Pass --force (-f) to confirm.`,
    )
    return
  }

  if (isSSH(agent.location)) {
    // A forced SSH removal skips remote teardown (its tmux session and dir) — the escape hatch
    // for an unreachable host — and removes state only. Scrub subscriptions here since this
    // path bypasses removeAgent.
    const s = await loadState(repoRoot)
    delete s.agents[args.agent]
    removeAgentFromSubscriptions(s, args.agent)
    await saveState(repoRoot, s)
    logger.success(`Agent "${args.agent}" removed from state (remote dir not cleaned up)`)
    return
  }

  // Tear the live tmux session down before deleting the dir, so removing a running agent
  // doesn't leave an orphaned process pointing at a directory that no longer exists.
  await killAgentSession(agent)

  await removeAgent(repoRoot, args.agent)
  logger.success(`Agent "${args.agent}" removed`)
}

/**
 * Kill an agent's quimby tmux session (local or remote), tolerating "no such session" so a
 * stopped agent removes cleanly. A local agent that was never run has no session to kill.
 */
async function killAgentSession(agent: Readonly<AgentState>): Promise<void> {
  if (!isSSH(agent.location) && !agent.tmux) return
  const session = tmuxSessionName(agent.id)
  try {
    if (isSSH(agent.location)) {
      await getSSHTransport(agent.location).exec(
        `tmux -L ${quimbyTmuxSocket} kill-session -t ${sq(session)}`,
      )
    } else {
      await execa('tmux', ['-L', quimbyTmuxSocket, 'kill-session', '-t', session])
    }
  } catch {
    // No live session (already stopped) — nothing to tear down.
  }
}
