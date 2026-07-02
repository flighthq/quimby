import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { getAgentDir, getAgentRepoDir } from '@quimbyhq/paths'
import type { AgentState } from '@quimbyhq/types'
import { loadState } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { join } from 'pathe'

export interface TempWorkspace {
  /** The workspace root — a real git repo that stands in for the user's project. */
  dir: string
  /** Remove the workspace tree. */
  cleanup(): Promise<void>
}

/**
 * Create a throwaway git repo to act as the "user repo" a quimby workspace lives in: initialized
 * on `main`, with a committed `README.md` so the tree is clean (a merge precondition) and a
 * configured identity so agent clones inherit a real author.
 */
export async function createTempWorkspace(): Promise<TempWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'qb-e2e-'))
  await git(dir, 'init', '-b', 'main')
  await git(dir, 'config', 'user.email', 'e2e@quimby.test')
  await git(dir, 'config', 'user.name', 'Quimby E2E')
  await writeFile(join(dir, 'README.md'), '# E2E project\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-m', 'initial')
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Run a git command in `cwd`, returning trimmed stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa('git', args, { cwd })).stdout.trim()
}

/** Load an agent's state entry by name (agents are keyed by UUID on disk, resolved via state). */
export async function agentState(workspaceDir: string, name: string): Promise<AgentState> {
  const state = await loadState(workspaceDir)
  const agent = state.agents[name]
  if (!agent) throw new Error(`agent "${name}" not found in ${workspaceDir}`)
  return agent
}

/** Absolute path to an agent's directory (parent of its repo/), resolved through its UUID. */
export async function agentDir(workspaceDir: string, name: string): Promise<string> {
  return getAgentDir(workspaceDir, (await agentState(workspaceDir, name)).id)
}

/** Absolute path to an agent's cloned repo. */
export async function agentRepoDir(workspaceDir: string, name: string): Promise<string> {
  return getAgentRepoDir(workspaceDir, (await agentState(workspaceDir, name)).id)
}

/**
 * Play the agent: write files into its repo and (optionally) commit them, mirroring what an AI
 * entrypoint would produce. With `commit` omitted the changes stay uncommitted (the working-tree
 * remainder a handoff/merge also carries).
 */
export async function agentEdit(
  workspaceDir: string,
  name: string,
  files: Record<string, string>,
  commitMessage?: string,
): Promise<void> {
  const repo = await agentRepoDir(workspaceDir, name)
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(repo, path), content)
  }
  if (commitMessage !== undefined) {
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-m', commitMessage)
  }
}
