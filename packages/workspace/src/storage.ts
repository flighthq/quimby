import { lstat, readdir, rename, rm, symlink } from 'node:fs/promises'

import { QuimbyError } from '@quimbyhq/errors'
import { getQuimbyDir, getStorageRoot, getStorageWorkspaceDir } from '@quimbyhq/paths'
import type { QuimbyState } from '@quimbyhq/types'
import { cp, ensureDir, exists, readYaml } from '@quimbyhq/utils'
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
    // A real `.quimby/` AND storage already holding this id. This used to `return` silently, which
    // left the project running on the local directory while the storage it believes it owns sat
    // elsewhere, diverging with nothing to say so — two `state.yaml` files for one id, one of them
    // ignored. Which of the two is authoritative is decidable only when one of them is empty.
    if (await isEmptyDir(storageDir)) {
      // Storage is a husk (an `ensureDir` from an aborted earlier run). The local directory is the
      // real workspace, so complete the migration that was interrupted.
      await rm(storageDir, { recursive: true, force: true })
      await rename(quimbyDir, storageDir)
      await linkQuimbyDir(repoRoot, storageDir)
      return
    }
    throw new QuimbyError(
      `Two quimby workspaces claim id "${projectId}": ${quimbyDir} (a real directory) and ` +
        `${storageDir} (durable storage), and both hold content. Quimby will not guess which is ` +
        'authoritative. Inspect both, then either remove the one you do not want or move the local ' +
        'directory aside and re-run to link the stored one.',
    )
  }

  await ensureDir(storageDir)
  await linkQuimbyDir(repoRoot, storageDir)
}

async function linkQuimbyDir(repoRoot: string, storageDir: string): Promise<void> {
  const quimbyDir = getQuimbyDir(repoRoot)
  if (await exists(quimbyDir)) {
    const stat = await lstat(quimbyDir)
    if (stat.isSymbolicLink()) return
    await clearDebrisQuimbyDir(quimbyDir, storageDir)
  }
  await symlink(resolve(storageDir), quimbyDir, 'dir')
}

/**
 * Remove a real `.quimby/` that is standing where the storage symlink belongs — but only when it is
 * demonstrably **debris** rather than a workspace.
 *
 * `state.yaml` is the discriminator, and it is a sharp one: without it there is no workspace here,
 * whatever else the directory holds. That case is not exotic. Deleting `.quimby` deletes only the
 * symlink (the durable storage it points at is untouched), and a **running `quimby serve` recreates
 * the directory within one poll cycle** — `reconcileAgentStatusMirror` does `mkdir -p` on
 * `.quimby/agents/<id>/status` for every agent, every cycle. So the workspace was intact, the
 * recovery path was one command away, and that command refused because of a directory the server
 * had just recreated out of thin air. `quimby restore` refused for the same reason, leaving no
 * in-tool way back.
 *
 * `local.yaml` is carried across rather than deleted: it is the one user-authored file that
 * legitimately lives here without a `state.yaml` (a host-alias binding written by `quimby host`),
 * and losing a private binding to a cleanup step would be its own small betrayal. Everything else
 * at this level — `server.json`, `tmux.conf`, `staging/`, mirror placeholders — is regenerated.
 */
async function clearDebrisQuimbyDir(quimbyDir: string, storageDir: string): Promise<void> {
  if (await exists(join(quimbyDir, 'state.yaml'))) {
    throw new QuimbyError(
      `Cannot restore quimby storage: ${quimbyDir} is a real directory holding its own state.yaml, ` +
        `and ${storageDir} holds the registered workspace. Quimby will not guess which is ` +
        'authoritative. Compare them, then move aside the one you do not want and re-run.',
    )
  }
  const strayConfig = join(quimbyDir, 'local.yaml')
  if ((await exists(strayConfig)) && !(await exists(join(storageDir, 'local.yaml')))) {
    await ensureDir(storageDir)
    await cp(strayConfig, join(storageDir, 'local.yaml'))
  }
  await rm(quimbyDir, { recursive: true, force: true })
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0
  } catch {
    return false
  }
}
