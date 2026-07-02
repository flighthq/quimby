import { spawn } from 'node:child_process'

import { getAgentWorkSummary } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getAgentRepoDir, QUIMBY_DIRNAME, remoteAgentRepoDir } from '@quimbyhq/paths'
import { getTransport } from '@quimbyhq/transport'
import type { AgentLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

import { formatWorkSummary } from '../workSummary'

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
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
    throw new QuimbyError(`Agent "${name}" not found`)
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

// The agent's commit subjects since its seed (`quimby/seed..HEAD`), newest first, for the
// diff header. Empty when there are none (uncommitted-only work) or the repo can't be read.
async function getCommitSubjects(
  repoRoot: string,
  stateId: string,
  agent: { id: string; location?: AgentLocation },
): Promise<string[]> {
  try {
    if (isSSH(agent.location)) {
      const transport = getTransport(agent.location)
      const rRepoDir = remoteAgentRepoDir(stateId, agent.id, agent.location.base)
      const out = await transport.exec(`git log quimby/seed..HEAD --format=%h %s`, {
        cwd: rRepoDir,
      })
      return out.split('\n').filter(Boolean)
    }
    const repoPath = getAgentRepoDir(repoRoot, agent.id)
    return (await git.log(repoPath, 'quimby/seed..HEAD', '%h %s')).split('\n').filter(Boolean)
  } catch {
    return []
  }
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

  const agent = state.agents[args.name]
  if (!agent) {
    throw new QuimbyError(`Agent "${args.name}" not found`)
  }

  // A merge-state header + commit list frame the diff: what's unmerged at a glance
  // (files / commits / ±lines) and which commits carry it, before the patch itself.
  const [diff, summary, commits] = await Promise.all([
    getDiff(repoRoot, args.name, state, args.stat),
    getAgentWorkSummary(repoRoot, state.id, agent),
    getCommitSubjects(repoRoot, state.id, agent),
  ])

  const header = [
    `${bold(args.name)}  ${dim(formatWorkSummary(summary))}`,
    ...commits.map((c) => `  ${dim(c)}`),
  ].join('\n')

  if (!diff) {
    console.log(`${header}\n${dim('(working tree matches seed)')}`)
    return
  }

  await page(`${header}\n\n${args.stat ? diff : colorizeDiff(diff)}`)
}
