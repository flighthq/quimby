import { QuimbyError } from '@quimbyhq/errors'
import { quimbyTmuxSocket, tmuxSessionName } from '@quimbyhq/paths'
import { getTransport, sq } from '@quimbyhq/transport'
import { isSSH } from '@quimbyhq/types'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

import { page } from '../pager'

// capture-pane without -e already emits plain text, but strip any stray SGR just in case.
const ANSI = /\x1b\[[0-9;]*m/g

export default defineCommand({
  meta: {
    name: 'log',
    description: "Show an agent's live tmux output (visible screen + scrollback)",
  },
  args: {
    name: {
      type: 'positional',
      description: 'Agent name',
      required: true,
    },
  },
  run: runLogCommand,
})

export async function runLogCommand({ args }: { args: { name: string } }) {
  const { state } = await resolveWorkspace()

  const agent = state.agents[args.name]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
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
      `"${args.name}" has no live tmux session "${session}" — start it with ` +
        `\`quimby start ${args.name}\` or \`quimby run ${args.name}\`.`,
    )
  }

  const text = output.replace(ANSI, '').trimEnd()
  if (!text) {
    console.log(`(no output captured from "${args.name}")`)
    return
  }
  await page(text)
}
