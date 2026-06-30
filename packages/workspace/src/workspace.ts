import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'

import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getQuimbyDir, getStatePath } from '@quimbyhq/paths'
import type { QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { ensureDir, exists, readYaml } from '@quimbyhq/utils'
import { execa } from 'execa'
import { join } from 'pathe'

import { migrateState, saveState } from './state'

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

  // Agent directories are now keyed by UUID; relocate any legacy name-keyed dirs in
  // place. Runs after IDs are guaranteed present, before any id-keyed path is used.
  await migrateAgentDirs(repoRoot, state)

  return { state, repoRoot }
}

/**
 * Move local agent directories from the legacy name-keyed layout
 * (`.quimby/agents/<name>`) to the UUID-keyed one (`.quimby/agents/<id>`). Idempotent:
 * skips an agent whose id-dir already exists or whose legacy dir is absent. Remote
 * (SSH) agents migrate lazily on their next `quimby run`.
 */
async function migrateAgentDirs(repoRoot: string, state: QuimbyState): Promise<void> {
  const agentsRoot = join(repoRoot, '.quimby', 'agents')
  for (const [name, agent] of Object.entries(state.agents)) {
    if (isSSH(agent.location) || name === agent.id) continue
    const legacy = join(agentsRoot, name)
    const current = join(agentsRoot, agent.id)
    if ((await exists(legacy)) && !(await exists(current))) {
      await rename(legacy, current)
    }
  }
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

  await saveState(repoRoot, state)
  await addToGitignore(repoRoot)

  return state
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
