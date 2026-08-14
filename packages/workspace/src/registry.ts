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
  // A path match still wins — but only when the origin does not CONTRADICT it. `repoRoot` is an
  // absolute path nothing revalidates, so it goes stale the moment a checkout is renamed, and the
  // vacated path can then be occupied by an entirely different project. That project matched the
  // old entry and silently inherited its workspace: same durable storage, same id, therefore the
  // same remote workspace and agent roster. Requiring the two identifiers not to disagree costs
  // nothing when they agree (the ordinary case) and is decisive exactly when the path was recycled.
  const byRoot = query.repoRoot
    ? projects.filter((p) => p.repoRoot === query.repoRoot && !contradicts(p, query.sourceRepo))
    : []
  if (byRoot.length > 0) return byRoot
  return query.sourceRepo ? projects.filter((p) => p.sourceRepo === query.sourceRepo) : []
}

// Two identifiers disagree only when BOTH are known. A missing origin on either side is absence of
// evidence, not evidence of a different project — an entry written before origins were recorded, or
// a query that never looked one up, must keep matching by path as it always did.
function contradicts(entry: Readonly<ProjectRegistryEntry>, sourceRepo?: string): boolean {
  if (!sourceRepo || !entry.sourceRepo) return false
  return entry.sourceRepo !== sourceRepo
}
