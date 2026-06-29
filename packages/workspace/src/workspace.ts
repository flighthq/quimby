import { appendFile, readFile, writeFile } from 'node:fs/promises'

import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getQuimbyDir, getStatePath } from '@quimbyhq/paths'
import type { QuimbyState } from '@quimbyhq/types'
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
    throw new QuimbyError('No quimby workspace found. Run `quimby add <name>` to create a worker.')
  }

  const state = await readYaml<QuimbyState>(statePath)

  // One-time migration: add stable IDs if missing (existing workspaces pre-date this field).
  let dirty = false
  if (!state.id) {
    state.id = crypto.randomUUID()
    dirty = true
  }
  for (const worker of Object.values(state.workers)) {
    if (!worker.id) {
      worker.id = crypto.randomUUID()
      dirty = true
    }
    // Workers created before sync targets existed advance against the workspace ref.
    if (!worker.syncRef) {
      worker.syncRef = state.sourceRef
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
    workers: {},
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
