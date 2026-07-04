import { getProjectRegistryPath, getStorageWorkspaceDir } from '@quimbyhq/paths'
import { ensureDir, exists, readYaml, writeYaml } from '@quimbyhq/utils'
import { dirname } from 'pathe'

export interface ProjectRegistryEntry {
  id: string
  repoRoot: string
  sourceRepo: string
  sourceRef?: string
  storagePath: string
  createdAt: string
  lastSeenAt: string
}

export interface ProjectRegistry {
  projects?: Record<string, ProjectRegistryEntry>
}

export async function loadProjectRegistry(): Promise<ProjectRegistry> {
  const path = getProjectRegistryPath()
  if (!(await exists(path))) return { projects: {} }
  return (await readYaml<ProjectRegistry>(path)) ?? { projects: {} }
}

export async function saveProjectRegistry(registry: Readonly<ProjectRegistry>): Promise<void> {
  const path = getProjectRegistryPath()
  await ensureDir(dirname(path))
  await writeYaml(path, { projects: registry.projects ?? {} })
}

export async function registerProject(
  entry: Readonly<
    Omit<ProjectRegistryEntry, 'storagePath' | 'lastSeenAt'> & { lastSeenAt?: string }
  >,
): Promise<ProjectRegistryEntry> {
  const registry = await loadProjectRegistry()
  const now = entry.lastSeenAt ?? new Date().toISOString()
  const existing = registry.projects?.[entry.id]
  const saved: ProjectRegistryEntry = {
    id: entry.id,
    repoRoot: entry.repoRoot,
    sourceRepo: entry.sourceRepo,
    ...(entry.sourceRef ? { sourceRef: entry.sourceRef } : {}),
    storagePath: getStorageWorkspaceDir(entry.id),
    createdAt: existing?.createdAt ?? entry.createdAt,
    lastSeenAt: now,
  }
  registry.projects = { ...(registry.projects ?? {}), [entry.id]: saved }
  await saveProjectRegistry(registry)
  return saved
}

export async function unregisterProject(id: string): Promise<boolean> {
  const registry = await loadProjectRegistry()
  if (!registry.projects?.[id]) return false
  delete registry.projects[id]
  await saveProjectRegistry(registry)
  return true
}

export function listRegistryProjects(registry: Readonly<ProjectRegistry>): ProjectRegistryEntry[] {
  return Object.values(registry.projects ?? {})
    .filter((entry): entry is ProjectRegistryEntry => typeof entry?.id === 'string')
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function findRegistryMatches(
  registry: Readonly<ProjectRegistry>,
  query: Readonly<{ id?: string; repoRoot?: string; sourceRepo?: string }>,
): ProjectRegistryEntry[] {
  const projects = listRegistryProjects(registry)
  if (query.id) return projects.filter((p) => p.id === query.id)
  const byRoot = query.repoRoot ? projects.filter((p) => p.repoRoot === query.repoRoot) : []
  if (byRoot.length > 0) return byRoot
  return query.sourceRepo ? projects.filter((p) => p.sourceRepo === query.sourceRepo) : []
}
