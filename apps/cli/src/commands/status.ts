import { getAgentDir, remoteAgentDir } from '@quimbyhq/paths'
import { getTransport } from '@quimbyhq/transport'
import { isSSH } from '@quimbyhq/types'
import { exists, readText } from '@quimbyhq/utils'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { join } from 'pathe'

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show agent-written status for agents',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Agent name (omit to show all)',
      required: false,
    },
  },
  run: runStatusCommand,
})

export async function runStatusCommand({ args }: { args: { name?: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const names = args.name ? [args.name] : Object.keys(state.agents)

  if (names.length === 0) {
    logger.info('No agents.')
    return
  }

  for (const name of names) {
    const agent = state.agents[name]
    if (!agent) {
      logger.warn(`Agent "${name}" not found`)
      continue
    }

    let statusContent = '(no status)'

    if (isSSH(agent.location)) {
      const transport = getTransport(agent.location)
      const rAgentDir = remoteAgentDir(state.id, agent.id, agent.location.base)
      try {
        statusContent = (await transport.readFile(`${rAgentDir}/status.md`)).trim() || '(empty)'
      } catch {
        statusContent = '(unreachable)'
      }
    } else {
      const statusPath = join(getAgentDir(repoRoot, agent.id), 'status.md')
      if (await exists(statusPath)) {
        statusContent = (await readText(statusPath)).trim() || '(empty)'
      }
    }

    console.log(`\n${bold(name)}`)
    console.log(statusContent)
  }
}
