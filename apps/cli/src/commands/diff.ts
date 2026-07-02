import { spawn } from 'node:child_process'

import * as git from '@quimbyhq/git'
import { getAgentRepoDir, QUIMBY_DIRNAME, remoteAgentRepoDir } from '@quimbyhq/paths'
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
  state: { id: string; agents: Record<string, { id: string; location?: AgentLocation }> },
  stat: boolean,
): Promise<string> {
  const agent = state.agents[name]
  if (!agent) {
    throw new Error(`"${name}" is not an agent`)
  }

  if (isSSH(agent.location)) {
    const transport = getTransport(agent.location)
    const rRepoDir = remoteAgentRepoDir(state.id, agent.id, agent.location.base)
    return stat
      ? transport.exec(`git diff --stat quimby/seed`, { cwd: rRepoDir })
      : transport.exec(`git diff quimby/seed`, { cwd: rRepoDir })
  }

  const repoPath = getAgentRepoDir(repoRoot, agent.id)
  if (stat) {
    const { stdout } = await execa('git', ['diff', '--stat', 'quimby/seed'], { cwd: repoPath })
    return stdout
  }
  // Full working tree (committed + uncommitted + untracked) — the same view a
  // handoff or apply would carry, including their exclusion of Quimby's own state.
  return git.diffWorkingTree(repoPath, 'quimby/seed', { exclude: [QUIMBY_DIRNAME] })
}

// Page output through the user's pager when attached to a TTY, so a large diff
// doesn't scroll off the terminal history. Falls back to printing when piped.
async function page(text: string): Promise<void> {
  if (!process.stdout.isTTY) {
    console.log(text)
    return
  }
  const pager = process.env.GIT_PAGER || process.env.PAGER || 'less -RFX'
  await new Promise<void>((resolve) => {
    const child = spawn(pager, { stdio: ['pipe', 'inherit', 'inherit'], shell: true })
    child.on('error', () => {
      console.log(text)
      resolve()
    })
    child.on('close', () => resolve())
    child.stdin.on('error', () => {}) // user quit the pager early — ignore EPIPE
    child.stdin.write(text)
    child.stdin.end()
  })
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

    const render = (d: string) => (d ? (args.stat ? d : colorizeDiff(d)) : '  (no changes)')
    await page(
      `${bold(`═══ ${args.name} ═══`)}\n${render(diffA)}\n\n` +
        `${bold(`═══ ${args.other} ═══`)}\n${render(diffB)}`,
    )
    return
  }

  const diff = await getDiff(repoRoot, args.name, state, args.stat)

  if (!diff) {
    console.log('No changes.')
    return
  }

  await page(args.stat ? diff : colorizeDiff(diff))
}
