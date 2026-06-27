import { join } from 'pathe'
import { rm } from 'node:fs/promises'
import { ensureDir, writeText, exists } from '../utils/fs.js'
import * as git from '../utils/git.js'
import { getWorkerDir, getWorkerRepoDir, getWorkersDir } from '../utils/paths.js'
import { QuimbyError } from '../utils/errors.js'
import { renderWorkerClaudeMd } from './template.js'
import { ensureWorkspace, saveState, loadState } from './workspace.js'
import type { WorkerState } from '../types/workspace.js'

export async function addWorker(
  repoRoot: string,
  name: string,
): Promise<WorkerState> {
  validateWorkerName(name)

  const state = await ensureWorkspace(repoRoot)

  if (state.workers[name]) {
    throw new QuimbyError(`Worker "${name}" already exists`)
  }

  const workerDir = getWorkerDir(repoRoot, name)
  const repoDir = getWorkerRepoDir(repoRoot, name)

  await ensureDir(workerDir)
  await ensureDir(join(workerDir, 'inbox'))

  await git.clone(repoRoot, repoDir, { ref: state.sourceRef })
  await git.tag(repoDir, 'quimby/seed')

  const seedCommit = await git.getCurrentRef(repoDir)

  await writeText(join(workerDir, 'assignment.md'), '')
  await writeText(join(workerDir, 'status.md'), 'idle')

  const claudeMd = renderWorkerClaudeMd({ workerName: name })
  await writeText(join(workerDir, 'CLAUDE.md'), claudeMd)

  const workerState: WorkerState = {
    name,
    seedCommit,
    createdAt: new Date().toISOString(),
  }

  state.workers[name] = workerState
  await saveState(repoRoot, state)

  return workerState
}

export async function removeWorker(
  repoRoot: string,
  name: string,
): Promise<void> {
  const state = await loadState(repoRoot)

  if (!state.workers[name]) {
    throw new QuimbyError(`Worker "${name}" not found`)
  }

  const workerDir = getWorkerDir(repoRoot, name)
  await rm(workerDir, { recursive: true, force: true })

  delete state.workers[name]
  await saveState(repoRoot, state)
}

export async function renameWorker(
  repoRoot: string,
  oldName: string,
  newName: string,
): Promise<void> {
  validateWorkerName(newName)

  const state = await loadState(repoRoot)

  if (!state.workers[oldName]) {
    throw new QuimbyError(`Worker "${oldName}" not found`)
  }

  if (state.workers[newName]) {
    throw new QuimbyError(`Worker "${newName}" already exists`)
  }

  const oldDir = getWorkerDir(repoRoot, oldName)
  const newDir = getWorkerDir(repoRoot, newName)

  const { rename } = await import('node:fs/promises')
  await rename(oldDir, newDir)

  const workerState = state.workers[oldName]
  workerState.name = newName
  delete state.workers[oldName]
  state.workers[newName] = workerState

  await saveState(repoRoot, state)
}

export async function resetWorker(
  repoRoot: string,
  name: string,
): Promise<void> {
  const state = await loadState(repoRoot)

  if (!state.workers[name]) {
    throw new QuimbyError(`Worker "${name}" not found`)
  }

  const workerDir = getWorkerDir(repoRoot, name)
  const repoDir = getWorkerRepoDir(repoRoot, name)

  await rm(repoDir, { recursive: true, force: true })

  const currentRef = await getCurrentBranchOrRef(repoRoot)
  await git.clone(repoRoot, repoDir, { ref: currentRef })
  await git.tag(repoDir, 'quimby/seed')

  const seedCommit = await git.getCurrentRef(repoDir)

  state.workers[name].seedCommit = seedCommit
  await saveState(repoRoot, state)

  await writeText(join(workerDir, 'assignment.md'), '')
  await writeText(join(workerDir, 'status.md'), 'idle')
}

function validateWorkerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new QuimbyError(
      `Invalid worker name "${name}". Use letters, numbers, hyphens, dots, and underscores.`,
    )
  }
}

async function getCurrentBranchOrRef(repoRoot: string): Promise<string> {
  try {
    const { execa } = await import('execa')
    const { stdout } = await execa(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: repoRoot },
    )
    const branch = stdout.trim()
    return branch === 'HEAD' ? await git.getCurrentRef(repoRoot) : branch
  } catch {
    return 'main'
  }
}
