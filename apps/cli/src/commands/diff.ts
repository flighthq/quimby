import * as git from '@quimbyhq/git'
import { getAgentRepoDir, remoteAgentRepoDir } from '@quimbyhq/paths'
import { getTransport } from '@quimbyhq/transport'
import type { AgentLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

function colorizeDiff(diff: string): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return bold(line)
      if (line.startsWith('@@')) return cyan(line)
      if (line.startsWith('+')) return green(line)
      if (line.startsWith('-')) return red(line)
      if (line.startsWith('diff ')) return bold(yellow(line))
      return line
    })
    .join('\n')
}

async function getDiff(
  repoRoot: string,
  name: string,
  state: { id: string; agents: Record<string, { location?: AgentLocation }> },
  stat: boolean,
): Promise<string> {
  const agent = state.agents[name]
  if (!agent) {
    throw new Error(`"${name}" is not an agent`)
  }

  if (isSSH(agent.location)) {
    const transport = getTransport(agent.location)
    const rRepoDir = remoteAgentRepoDir(state.id, name, agent.location.base)
    return stat
      ? transport.exec(`git diff --stat quimby/seed`, { cwd: rRepoDir })
      : transport.exec(`git diff quimby/seed`, { cwd: rRepoDir })
  }

  const repoPath = getAgentRepoDir(repoRoot, name)
  if (stat) {
    const { stdout } = await execa('git', ['diff', '--stat', 'quimby/seed'], { cwd: repoPath })
    return stdout
  }
  return git.diff(repoPath, 'quimby/seed')
}

export default defineCommand({
  meta: {
    name: 'diff',
    description: "Show an agent's changes against its seed",
  },
  args: {
    name: {
      type: 'positional',
      description: 'Agent name',
      required: true,
    },
    other: {
      type: 'positional',
      description: 'Second agent (side-by-side)',
      required: false,
    },
    stat: {
      type: 'boolean',
      description: 'Show diffstat summary only',
      default: false,
    },
  },
  run: runDiffCommand,
})

export async function runDiffCommand({
  args,
}: {
  args: { name: string; other?: string; stat: boolean }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  if (args.other) {
    const [diffA, diffB] = await Promise.all([
      getDiff(repoRoot, args.name, state, args.stat),
      getDiff(repoRoot, args.other, state, args.stat),
    ])

    console.log(bold(`\n═══ ${args.name} ═══`))
    console.log(diffA ? (args.stat ? diffA : colorizeDiff(diffA)) : '  (no changes)')

    console.log(bold(`\n═══ ${args.other} ═══`))
    console.log(diffB ? (args.stat ? diffB : colorizeDiff(diffB)) : '  (no changes)')
    return
  }

  const diff = await getDiff(repoRoot, args.name, state, args.stat)

  if (!diff) {
    console.log('No changes.')
    return
  }

  console.log(args.stat ? diff : colorizeDiff(diff))
}
