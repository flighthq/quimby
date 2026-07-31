import { lstat, readdir, rename, rm, symlink } from 'node:fs/promises'

import { QuimbyError } from '@quimbyhq/errors'
import { getQuimbyDir, getStorageRoot, getStorageWorkspaceDir } from '@quimbyhq/paths'
import type { QuimbyState } from '@quimbyhq/types'
import { ensureDir, exists, readYaml } from '@quimbyhq/utils'
import { dirname, join, resolve } from 'pathe'

import type { ProjectRegistryEntry } from './registry'
import {
  findRegistryMatches,
  listRegistryProjects,
  loadProjectRegistry,
  registerProject,
  unregisterProject,
} from './registry'

export interface StorageWorkspace {
  id: string
  path: string
  registered: boolean
  repoRoot?: string
  sourceRepo?: string
  sourceRef?: string
  exists: boolean
}

export async function ensureDurableWorkspace(
  repoRoot: string,
  state: Readonly<QuimbyState>,
): Promise<ProjectRegistryEntry> {
  await materializeWorkspaceStorage(repoRoot, state.id)
  return registerProject({
    id: state.id,
    repoRoot,
    sourceRepo: state.sourceRepo,
    sourceRef: state.sourceRef,
    createdAt: state.createdAt,
  })
}

export async function restoreWorkspaceLink(
  repoRoot: string,
  query: Readonly<{ id?: string; sourceRepo?: string }> = {},
): Promise<ProjectRegistryEntry | null> {
  const registry = await loadProjectRegistry()
  const matches = findRegistryMatches(registry, {
    id: query.id,
    repoRoot,
    sourceRepo: query.sourceRepo,
  })
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw new QuimbyError(
      `Multiple quimby workspaces match this repository: ${matches.map((m) => m.id).join(', ')}. Run \`quimby restore --id <id>\`.`,
    )
  }
  const entry = matches[0]
  if (!(await exists(entry.storagePath))) {
    throw new QuimbyError(`Registered workspace "${entry.id}" is missing at ${entry.storagePath}`)
  }
  await linkQuimbyDir(repoRoot, entry.storagePath)
  await registerProject({
    id: entry.id,
    repoRoot,
    sourceRepo: entry.sourceRepo,
    sourceRef: entry.sourceRef,
    createdAt: entry.createdAt,
  })
  return entry
}

export async function listStorageWorkspaces(): Promise<StorageWorkspace[]> {
  const registry = await loadProjectRegistry()
  const registered = new Map<string, StorageWorkspace>(
    listRegistryProjects(registry).map((entry) => [
      entry.id,
      {
        id: entry.id,
        path: entry.storagePath,
        registered: true,
        repoRoot: entry.repoRoot,
        sourceRepo: entry.sourceRepo,
        sourceRef: entry.sourceRef,
        exists: false,
      },
    ]),
  )

  const root = getStorageRoot()
  if (await exists(root)) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      const path = getStorageWorkspaceDir(id)
      const current = registered.get(id)
      if (current) current.exists = true
      else registered.set(id, { id, path, registered: false, exists: true })
    }
  }

  return [...registered.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export async function pruneStorageWorkspaces(
  opts: Readonly<{ force?: boolean; stale?: boolean }> = {},
): Promise<StorageWorkspace[]> {
  const workspaces = await listStorageWorkspaces()
  const unregistered = workspaces.filter((w) => w.exists && !w.registered)
  const targets = [...unregistered, ...(opts.stale ? await listStaleRegisteredWorkspaces() : [])]
  if (opts.force) {
    for (const workspace of targets) {
      // A registered entry must be unregistered as well, or the id lingers in the registry
      // pointing at a directory that is gone — the mirror image of the residue being cleaned.
      if (workspace.registered) await removeStorageWorkspace(workspace.id)
      else await rm(workspace.path, { recursive: true, force: true })
    }
  }
  return targets
}

/**
 * Registered workspaces whose project directory no longer exists.
 *
 * The default prune only takes *unregistered* directories, which misses the residue that actually
 * accumulates: anything that ran the real CLI registered itself, so its entry is present while its
 * project (a temp dir, a deleted checkout) is long gone. Those are invisible to `prune` and to
 * `list`'s flags alike, since both read as "registered, present".
 *
 * Kept opt-in behind `--stale`: a missing project directory is strong evidence but not proof — an
 * unmounted drive or a moved checkout looks identical, so the user reviews before removing.
 */
export async function listStaleRegisteredWorkspaces(): Promise<StorageWorkspace[]> {
  const out: StorageWorkspace[] = []
  for (const workspace of await listStorageWorkspaces()) {
    if (!workspace.registered || !workspace.exists || !workspace.repoRoot) continue
    if (!(await exists(workspace.repoRoot))) out.push(workspace)
  }
  return out
}

export async function removeStorageWorkspace(id: string): Promise<boolean> {
  const path = getStorageWorkspaceDir(id)
  const existed = await exists(path)
  await rm(path, { recursive: true, force: true })
  await unregisterProject(id)
  return existed
}

export async function readStoredState(id: string): Promise<QuimbyState> {
  return readYaml<QuimbyState>(join(getStorageWorkspaceDir(id), 'state.yaml'))
}

async function materializeWorkspaceStorage(repoRoot: string, projectId: string): Promise<void> {
  const quimbyDir = getQuimbyDir(repoRoot)
  const storageDir = getStorageWorkspaceDir(projectId)
  await ensureDir(dirname(storageDir))

  if (await exists(quimbyDir)) {
    const stat = await lstat(quimbyDir)
    if (stat.isSymbolicLink()) return
    if (!(await exists(storageDir))) {
      await rename(quimbyDir, storageDir)
      await linkQuimbyDir(repoRoot, storageDir)
      return
    }
    return
  }

  await ensureDir(storageDir)
  await linkQuimbyDir(repoRoot, storageDir)
}

async function linkQuimbyDir(repoRoot: string, storageDir: string): Promise<void> {
  const quimbyDir = getQuimbyDir(repoRoot)
  if (await exists(quimbyDir)) {
    const stat = await lstat(quimbyDir)
    if (stat.isSymbolicLink()) return
    throw new QuimbyError(`Cannot restore quimby storage: ${quimbyDir} already exists`)
  }
  await symlink(resolve(storageDir), quimbyDir, 'dir')
}
