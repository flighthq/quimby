import { rebuildAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { killAgentSession } from '@quimbyhq/session'
import { logger } from '@quimbyhq/utils'
import { loadState, resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { teardownAgentSandbox } from '../agentTeardown'

export default defineCommand({
  meta: {
    name: 'rebuild',
    description:
      'Recreate an agent from current source (destructive — discards its work and mailbox)',
  },
  args: {
    // Not `required`: a bare `rebuild` (or `rebuild --all`) must reach run() so it can explain
    // itself, rather than citty aborting with a generic "Missing required positional: AGENT".
    agent: {
      type: 'positional',
      description: 'Agent name',
      required: false,
    },
    all: {
      type: 'boolean',
      description: 'Not supported — rebuild runs one agent at a time (it is destructive)',
      default: false,
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    },
  },
  run: runRebuildCommand,
})

export async function runRebuildCommand({
  args,
}: {
  args: { agent?: string; all: boolean; force: boolean }
}) {
  // Validate the invocation before touching the workspace, so `--all` (or a bare `rebuild`)
  // reports its own clear reason rather than a "No workspace found" / missing-positional error.
  // Rebuild is deliberately per-agent: it discards an agent's work and mailbox, so there is no
  // bulk `--all` (unlike `sync`/`restart`).
  if (args.all) {
    throw new QuimbyError(
      "rebuild does not support --all — it discards each agent's work and mailbox, so run it one " +
        'agent at a time (e.g. `quimby rebuild <agent> --force`). To reset code across agents while ' +
        'keeping their mailboxes, use `quimby sync --all -f`; to restart sessions, `quimby restart --all`.',
    )
  }
  if (!args.agent) {
    throw new QuimbyError('Specify an agent to rebuild (e.g. `quimby rebuild <agent> --force`).')
  }

  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.agent]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }

  if (!args.force) {
    logger.warn(
      `This recreates "${args.agent}" from scratch, discarding its work and handoff mailbox. Pass --force (-f) to confirm.`,
    )
    return
  }

  // Rebuild is "start a blank one", so end the live session and its sandbox first. A running
  // agent is attached to the sandbox/session created against the *old* repo; sbx reuses a
  // sandbox by name, so without removing it the next `run` would show the stale, pre-rebuild
  // tree instead of the fresh clone. Both steps are best-effort and cover SSH agents too.
  await killAgentSession(agent)
  await teardownAgentSandbox({ state, repoRoot, agent, name: args.agent })

  await rebuildAgent(repoRoot, args.agent)

  const newState = await loadState(repoRoot)
  const newSeed = newState.agents[args.agent].seedCommit

  logger.success(`Agent "${args.agent}" rebuilt (seed: ${newSeed.slice(0, 8)})`)
  logger.info(`Run \`quimby run ${args.agent}\` to launch a fresh session on the new clone.`)
}
