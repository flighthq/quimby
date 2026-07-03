import { QuimbyError } from '@quimbyhq/errors'
import { getAgentSessionLogPath, quimbyTmuxSocket, tmuxSessionName } from '@quimbyhq/paths'
import { getTransport, sq } from '@quimbyhq/transport'
import { isSSH } from '@quimbyhq/types'
import { exists, logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

import { page } from '../pager'

// capture-pane without -e already emits plain text, but strip any stray SGR just in case.
const ANSI = /\x1b\[[0-9;]*m/g

export default defineCommand({
  meta: {
    name: 'log',
    description: "Show an agent's tmux output (live screen, or --follow the durable transcript)",
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent name',
      required: true,
    },
    follow: {
      type: 'boolean',
      alias: 'f',
      description: 'Stream the durable transcript (session.log) as it grows, like `tail -f`',
      default: false,
    },
  },
  run: runLogCommand,
})

export async function runLogCommand({ args }: { args: { agent: string; follow: boolean } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const agent = state.agents[args.agent]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.agent}" not found`)
  }

  if (args.follow) {
    if (isSSH(agent.location)) {
      throw new QuimbyError(
        `--follow isn't available for the SSH agent "${args.agent}" (its transcript lives on the ` +
          `remote host) — use \`quimby log ${args.agent}\` for its live screen.`,
      )
    }
    const logPath = getAgentSessionLogPath(repoRoot, agent.id)
    if (!(await exists(logPath))) {
      throw new QuimbyError(
        `No transcript yet for "${args.agent}" — it's written once the agent is launched with ` +
          `\`quimby start ${args.agent}\` or \`quimby run ${args.agent}\`.`,
      )
    }
    logger.info(`Following "${args.agent}" transcript (Ctrl-C to stop): ${logPath}`)
    // Show a tail of recent output, then stream new lines. Inherit stdio so it's live; a
    // SIGINT (Ctrl-C) ends tail and returns cleanly rather than throwing.
    await execa('tail', ['-n', '100', '-f', logPath], { stdio: 'inherit', reject: false })
    return
  }

  const session = tmuxSessionName(agent.id)
  let output: string
  try {
    if (isSSH(agent.location)) {
      // `-S -` captures from the start of scrollback history; `-p` prints to stdout.
      output = await getTransport(agent.location).exec(
        `tmux -L ${quimbyTmuxSocket} capture-pane -p -S - -t ${sq(session)}`,
      )
    } else {
      output = (
        await execa('tmux', [
          '-L',
          quimbyTmuxSocket,
          'capture-pane',
          '-p',
          '-S',
          '-',
          '-t',
          session,
        ])
      ).stdout
    }
  } catch {
    throw new QuimbyError(
      `"${args.agent}" has no live tmux session "${session}" — start it with ` +
        `\`quimby start ${args.agent}\` or \`quimby run ${args.agent}\`.`,
    )
  }

  const text = output.replace(ANSI, '').trimEnd()
  if (!text) {
    console.log(`(no output captured from "${args.agent}")`)
    return
  }
  await page(text)
}
