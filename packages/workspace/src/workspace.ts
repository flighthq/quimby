import { appendFile, readFile, writeFile } from 'node:fs/promises'

import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getQuimbyDir, getStatePath } from '@quimbyhq/paths'
import type { AgentState, QuimbyState } from '@quimbyhq/types'
import { ensureDir, exists, readYaml, writeYaml } from '@quimbyhq/utils'
import { execa } from 'execa'
import { join } from 'pathe'

export async function resolveWorkspace(): Promise<{
  state: QuimbyState
  repoRoot: string
}> {
  const cwd = process.cwd()
  const repoRoot = await git.findRoot(cwd)

  if (!repoRoot) {
    throw new QuimbyError('Not inside a git repository. Run from within a git repo.')
  }

  const statePath = getStatePath(repoRoot)

  if (!(await exists(statePath))) {
    throw new QuimbyError('No quimby workspace found. Run `quimby add <name>` to create an agent.')
  }

  const state = await readYaml<QuimbyState>(statePath)

  let dirty = migrateState(state)

  // One-time migration: add stable IDs if missing (existing workspaces pre-date this field).
  if (!state.id) {
    state.id = crypto.randomUUID()
    dirty = true
  }
  for (const agent of Object.values(state.agents)) {
    if (!agent.id) {
      agent.id = crypto.randomUUID()
      dirty = true
    }
    // Agents created before sync targets existed advance against the workspace ref.
    if (!agent.syncRef) {
      agent.syncRef = state.sourceRef
      dirty = true
    }
  }
  if (dirty) await saveState(repoRoot, state)

  return { state, repoRoot }
}

export async function ensureWorkspace(repoRoot: string): Promise<QuimbyState> {
  const statePath = getStatePath(repoRoot)

  if (await exists(statePath)) {
    return readYaml<QuimbyState>(statePath)
  }

  const quimbyDir = getQuimbyDir(repoRoot)
  await ensureDir(quimbyDir)

  const sourceRepo = (await git.getRemoteUrl(repoRoot)) ?? repoRoot
  const sourceRef = await getCurrentBranch(repoRoot)
  const snapshot = await git.getCurrentRef(repoRoot)

  const state: QuimbyState = {
    id: crypto.randomUUID(),
    sourceRepo,
    sourceRef,
    snapshot,
    createdAt: new Date().toISOString(),
    agents: {},
  }

  await writeYaml(statePath, state)
  await addToGitignore(repoRoot)

  return state
}

export async function loadState(repoRoot: string): Promise<QuimbyState> {
  return readYaml<QuimbyState>(getStatePath(repoRoot))
}

export async function saveState(repoRoot: string, state: QuimbyState): Promise<void> {
  await writeYaml(getStatePath(repoRoot), state)
}

/**
 * Rename legacy schema keys in place so state files predating the `workers`→`agents`,
 * `defaults.agent`→`defaults.entrypoint`, and `check`→`guard` renames load cleanly.
 * Returns true when something was migrated (the caller persists the result).
 */
function migrateState(state: QuimbyState): boolean {
  let dirty = false
  const loose = state as QuimbyState & {
    workers?: QuimbyState['agents']
  }

  if (loose.workers && !state.agents) {
    state.agents = loose.workers
    delete loose.workers
    dirty = true
  }

  for (const agent of Object.values(state.agents ?? {})) {
    const looseAgent = agent as AgentState & {
      defaults?: { agent?: string }
      check?: string
    }
    if (looseAgent.defaults?.agent && !looseAgent.defaults.entrypoint) {
      looseAgent.defaults.entrypoint = looseAgent.defaults.agent
      delete looseAgent.defaults.agent
      dirty = true
    }
    if (looseAgent.check && !looseAgent.guard) {
      looseAgent.guard = looseAgent.check
      delete looseAgent.check
      dirty = true
    }
  }

  return dirty
}

async function getCurrentBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
    return stdout.trim()
  } catch {
    return 'main'
  }
}

async function addToGitignore(repoRoot: string): Promise<void> {
  const gitignorePath = join(repoRoot, '.gitignore')

  if (await exists(gitignorePath)) {
    const content = await readFile(gitignorePath, 'utf-8')
    if (content.split('\n').some((line) => line.trim() === '.quimby')) {
      return
    }
    await appendFile(gitignorePath, '\n.quimby\n')
  } else {
    await writeFile(gitignorePath, '.quimby\n', 'utf-8')
  }
}
