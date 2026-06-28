import { rename, rm } from 'node:fs/promises'

import { execa } from 'execa'
import { join } from 'pathe'

import type { SSHLocation, WorkerLocation } from '../types/location'
import { isSSH } from '../types/location'
import type { QuimbyState, WorkerState } from '../types/workspace'
import { QuimbyError } from '../utils/errors'
import { ensureDir, writeText } from '../utils/fs'
import * as git from '../utils/git'
import {
  getWorkerDir,
  getWorkerOutboxDir,
  getWorkerRepoDir,
  remoteProjectRoot,
  remoteQuimbyDir,
  remoteWorkerDir,
  remoteWorkerRepoDir,
} from '../utils/paths'
import { renderWorkerClaudeMd } from './template'
import type { Transport } from './transport'
import { getSSHTransport } from './transport'
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
  await ensureDir(getWorkerOutboxDir(repoRoot, name))

  await git.clone(repoRoot, repoDir, { ref: state.sourceRef })
  await git.tag(repoDir, 'quimby/seed')
  await configureWorkerIdentity(repoRoot, repoDir, name)

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

export async function setWorkerCheck(repoRoot: string, name: string, check: string): Promise<void> {
  const state = await loadState(repoRoot)
  if (!state.workers[name]) {
    throw new QuimbyError(`Worker "${name}" not found`)
  }
  // An empty string clears the check; any non-empty value sets it.
  if (check) {
    state.workers[name].check = check
  } else {
    delete state.workers[name].check
  }
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

    await transport.syncProjectTo(repoRoot, rRoot)
    await transport.exec(`rm -rf ${rRepoDir}`)
    await transport.ensureDir(`${rWorkerDir}/inbox/packs`)
    await transport.ensureDir(`${rWorkerDir}/inbox/status`)
    await transport.ensureDir(`${rWorkerDir}/outbox`)
    await transport.exec(`git clone ${rRoot} ${rRepoDir}`, { cwd: rQuimby })
    await transport.exec(`git tag quimby/seed`, { cwd: rRepoDir })
    await configureRemoteWorkerIdentity(transport, rRepoDir, name)
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
  await configureWorkerIdentity(repoRoot, repoDir, name)

  const seedCommit = await git.getCurrentRef(repoDir)

  state.workers[name].seedCommit = seedCommit
  await saveState(repoRoot, state)

  await writeText(join(workerDir, 'assignment.md'), '')
  await writeText(join(workerDir, 'status.md'), 'idle')
}

export async function advanceWorker(
  repoRoot: string,
  name: string,
): Promise<{ newSeed: string; rebased: boolean; commitsReplayed: number }> {
  const state = await loadState(repoRoot)

  if (!state.workers[name]) {
    throw new QuimbyError(`Worker "${name}" not found`)
  }

  const worker = state.workers[name]

  if (isSSH(worker.location)) {
    return advanceSSHWorker(repoRoot, name, worker, state)
  }

  const repoDir = getWorkerRepoDir(repoRoot, name)

  if (!(await git.isClean(repoDir))) {
    throw new QuimbyError(
      `Worker "${name}" has uncommitted changes — commit them first so they can be rebased onto the new baseline`,
    )
  }

  const hostHead = await git.getCurrentRef(repoRoot)

  if (hostHead === worker.seedCommit) {
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  const logOutput = await git.log(repoDir, 'quimby/seed..HEAD', '%H')
  const workerCommits = logOutput.split('\n').filter(Boolean)
  const commitsReplayed = workerCommits.length

  await git.fetch(repoDir, 'origin')

  if (commitsReplayed === 0) {
    await git.resetHard(repoDir, hostHead)
    await git.tagForce(repoDir, 'quimby/seed')
    state.workers[name].seedCommit = hostHead
    await saveState(repoRoot, state)
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  try {
    await git.rebase(repoDir, hostHead)
  } catch {
    await git.rebaseAbort(repoDir)
    throw new QuimbyError(
      `Worker "${name}" has rebase conflicts — resolve them manually or run "quimby reset ${name} --force" to start fresh`,
    )
  }

  // Tag the new base (hostHead), not the rebased HEAD
  await git.tagForce(repoDir, 'quimby/seed', hostHead)
  state.workers[name].seedCommit = hostHead
  await saveState(repoRoot, state)

  return { newSeed: hostHead, rebased: true, commitsReplayed }
}

async function advanceSSHWorker(
  repoRoot: string,
  name: string,
  worker: WorkerState,
  state: QuimbyState,
): Promise<{ newSeed: string; rebased: boolean; commitsReplayed: number }> {
  const location = worker.location as SSHLocation
  const transport = getSSHTransport(location)
  const rRoot = remoteProjectRoot(state.id, location.base)
  const rRepoDir = remoteWorkerRepoDir(state.id, name, location.base)

  await transport.syncProjectTo(repoRoot, rRoot)

  const hostHead = await git.getCurrentRef(repoRoot)

  if (hostHead === worker.seedCommit) {
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  const statusOutput = await transport.exec(`git status --porcelain`, { cwd: rRepoDir })
  if (statusOutput.trim()) {
    throw new QuimbyError(
      `Worker "${name}" has uncommitted changes — commit them first so they can be rebased onto the new baseline`,
    )
  }

  const logOutput = await transport.exec(`git log quimby/seed..HEAD --format=%H`, {
    cwd: rRepoDir,
  })
  const workerCommits = logOutput.split('\n').filter(Boolean)
  const commitsReplayed = workerCommits.length

  await transport.exec(`git fetch origin`, { cwd: rRepoDir })

  if (commitsReplayed === 0) {
    await transport.exec(`git reset --hard ${hostHead}`, { cwd: rRepoDir })
    await transport.exec(`git tag -f quimby/seed`, { cwd: rRepoDir })
    state.workers[name].seedCommit = hostHead
    await saveState(repoRoot, state)
    return { newSeed: hostHead, rebased: false, commitsReplayed: 0 }
  }

  try {
    await transport.exec(`git rebase ${hostHead}`, { cwd: rRepoDir })
  } catch {
    await transport.exec(`git rebase --abort`, { cwd: rRepoDir }).catch(() => {})
    throw new QuimbyError(
      `Worker "${name}" has rebase conflicts — run "quimby reset ${name} --force" to start fresh`,
    )
  }

  await transport.exec(`git tag -f quimby/seed ${hostHead}`, { cwd: rRepoDir })
  state.workers[name].seedCommit = hostHead
  await saveState(repoRoot, state)

  return { newSeed: hostHead, rebased: true, commitsReplayed }
}

/**
 * Configure git identity in a local worker clone so the agent never has to set
 * git globals before its first commit. Inherits the host repo's identity when
 * present, else falls back to a quimby-scoped identity.
 */
async function configureWorkerIdentity(
  repoRoot: string,
  repoDir: string,
  workerName: string,
): Promise<void> {
  const name = (await git.getConfig(repoRoot, 'user.name')) ?? `quimby-${workerName}`
  const email = (await git.getConfig(repoRoot, 'user.email')) ?? `quimby+${workerName}@local`
  await git.setConfig(repoDir, 'user.name', name)
  await git.setConfig(repoDir, 'user.email', email)
}

/**
 * Configure git identity in a remote worker clone. Inherits the remote machine's
 * global identity when present, else falls back to a quimby-scoped identity.
 * Worker names are validated to contain no shell metacharacters, so they are
 * safe to interpolate into the remote command.
 */
export async function configureRemoteWorkerIdentity(
  transport: Transport,
  repoDir: string,
  workerName: string,
): Promise<void> {
  await transport.exec(
    `git config user.name "$(git config --global user.name 2>/dev/null || echo 'quimby-${workerName}')" && ` +
      `git config user.email "$(git config --global user.email 2>/dev/null || echo 'quimby+${workerName}@local')"`,
    { cwd: repoDir },
  )
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
