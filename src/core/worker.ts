import { rename, rm } from 'node:fs/promises'

import { execa } from 'execa'
import { join } from 'pathe'

import type { WorkerLocation } from '../types/location'
import { isSSH } from '../types/location'
import type { WorkerState } from '../types/workspace'
import { QuimbyError } from '../utils/errors'
import { ensureDir, writeText } from '../utils/fs'
import * as git from '../utils/git'
import {
  getWorkerDir,
  getWorkerRepoDir,
  remoteProjectRoot,
  remoteQuimbyDir,
  remoteWorkerDir,
  remoteWorkerRepoDir,
} from '../utils/paths'
import { renderWorkerClaudeMd } from './template'
import { getSSHTransport, syncToRemote } from './transport'
import { ensureWorkspace, loadState, saveState } from './workspace'

export async function addWorker(
  repoRoot: string,
  name: string,
  opts?: {
    defaults?: { runtime?: string; agent?: string }
    location?: WorkerLocation
  },
): Promise<WorkerState> {
  validateWorkerName(name)

  const state = await ensureWorkspace(repoRoot)

  if (state.workers[name]) {
    throw new QuimbyError(`Worker "${name}" already exists`)
  }

  const workerState: WorkerState = {
    id: crypto.randomUUID(),
    name,
    seedCommit: '',
    createdAt: new Date().toISOString(),
    ...(opts?.defaults ? { defaults: opts.defaults } : {}),
    ...(opts?.location ? { location: opts.location } : {}),
  }

  if (isSSH(opts?.location)) {
    // Remote workers are initialized lazily on first `quimby run`.
    // Record the current HEAD as the intended seed baseline.
    workerState.seedCommit = await git.getCurrentRef(repoRoot)
    state.workers[name] = workerState
    await saveState(repoRoot, state)
    return workerState
  }

  // Local worker: create dirs, clone, tag, write files.
  const workerDir = getWorkerDir(repoRoot, name)
  const repoDir = getWorkerRepoDir(repoRoot, name)

  await ensureDir(join(workerDir, 'inbox', 'packs'))
  await ensureDir(join(workerDir, 'inbox', 'status'))

  await git.clone(repoRoot, repoDir, { ref: state.sourceRef })
  await git.tag(repoDir, 'quimby/seed')

  workerState.seedCommit = await git.getCurrentRef(repoDir)

  await writeText(join(workerDir, 'assignment.md'), '')
  await writeText(join(workerDir, 'status.md'), 'idle')

  const claudeMd = renderWorkerClaudeMd({ workerName: name })
  await writeText(join(workerDir, 'CLAUDE.md'), claudeMd)

  state.workers[name] = workerState
  await saveState(repoRoot, state)

  return workerState
}

export async function setWorkerDefaults(
  repoRoot: string,
  name: string,
  updates: { runtime?: string; agent?: string },
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!state.workers[name]) {
    throw new QuimbyError(`Worker "${name}" not found`)
  }
  state.workers[name].defaults = { ...state.workers[name].defaults, ...updates }
  await saveState(repoRoot, state)
}

export async function setWorkerLocation(
  repoRoot: string,
  name: string,
  location: WorkerLocation,
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!state.workers[name]) {
    throw new QuimbyError(`Worker "${name}" not found`)
  }
  state.workers[name].location = location
  await saveState(repoRoot, state)
}

export async function removeWorker(repoRoot: string, name: string): Promise<void> {
  const state = await loadState(repoRoot)

  if (!state.workers[name]) {
    throw new QuimbyError(`Worker "${name}" not found`)
  }

  const worker = state.workers[name]

  if (isSSH(worker.location)) {
    const transport = getSSHTransport(worker.location)
    const rWorkerDir = remoteWorkerDir(state.id, name, worker.location.base)
    await transport.exec(`rm -rf ${rWorkerDir}`)
  } else {
    const workerDir = getWorkerDir(repoRoot, name)
    await rm(workerDir, { recursive: true, force: true })
  }

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

  const worker = state.workers[oldName]

  if (isSSH(worker.location)) {
    const transport = getSSHTransport(worker.location)
    const oldDir = remoteWorkerDir(state.id, oldName, worker.location.base)
    const newDir = remoteWorkerDir(state.id, newName, worker.location.base)
    await transport.exec(`mv ${oldDir} ${newDir}`)
  } else {
    const oldDir = getWorkerDir(repoRoot, oldName)
    const newDir = getWorkerDir(repoRoot, newName)
    await rename(oldDir, newDir)
  }

  worker.name = newName
  delete state.workers[oldName]
  state.workers[newName] = worker

  await saveState(repoRoot, state)
}

export async function resetWorker(repoRoot: string, name: string): Promise<void> {
  const state = await loadState(repoRoot)

  if (!state.workers[name]) {
    throw new QuimbyError(`Worker "${name}" not found`)
  }

  const worker = state.workers[name]

  if (isSSH(worker.location)) {
    const transport = getSSHTransport(worker.location)
    const rRoot = remoteProjectRoot(state.id, worker.location.base)
    const rQuimby = remoteQuimbyDir(state.id, worker.location.base)
    const rWorkerDir = remoteWorkerDir(state.id, name, worker.location.base)
    const rRepoDir = remoteWorkerRepoDir(state.id, name, worker.location.base)

    await syncToRemote(repoRoot, rRoot, worker.location)
    await transport.exec(`rm -rf ${rRepoDir}`)
    await transport.ensureDir(`${rWorkerDir}/inbox/packs`)
    await transport.ensureDir(`${rWorkerDir}/inbox/status`)
    await transport.exec(`git clone ${rRoot} ${rRepoDir}`, { cwd: rQuimby })
    await transport.exec(`git tag quimby/seed`, { cwd: rRepoDir })
    const seedCommit = (await transport.exec(`git rev-parse HEAD`, { cwd: rRepoDir })).trim()

    await transport.writeFile(`${rWorkerDir}/assignment.md`, '')
    await transport.writeFile(`${rWorkerDir}/status.md`, 'idle')

    state.workers[name].seedCommit = seedCommit
    await saveState(repoRoot, state)
    return
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
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
    const branch = stdout.trim()
    return branch === 'HEAD' ? await git.getCurrentRef(repoRoot) : branch
  } catch {
    return 'main'
  }
}
