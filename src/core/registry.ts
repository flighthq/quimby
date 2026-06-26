import { readYaml, writeYaml } from '../utils/yaml.js'
import { ensureDir, exists } from '../utils/fs.js'
import { getAoHome, getRegistryPath } from '../utils/paths.js'
import { dirname } from 'pathe'

export interface RegistryEntry {
  name: string
  sourceRepo: string
  path: string
  createdAt: string
}

export interface Registry {
  workspaces: RegistryEntry[]
}

export async function loadRegistry(): Promise<Registry> {
  const registryPath = getRegistryPath()
  if (!(await exists(registryPath))) {
    return { workspaces: [] }
  }
  const data = await readYaml<Registry>(registryPath)
  return data ?? { workspaces: [] }
}

export async function saveRegistry(registry: Registry): Promise<void> {
  const registryPath = getRegistryPath()
  await ensureDir(dirname(registryPath))
  await writeYaml(registryPath, registry)
}

export async function addToRegistry(entry: RegistryEntry): Promise<void> {
  const registry = await loadRegistry()
  const idx = registry.workspaces.findIndex((w) => w.name === entry.name)
  if (idx >= 0) {
    registry.workspaces[idx] = entry
  } else {
    registry.workspaces.push(entry)
  }
  await saveRegistry(registry)
}

export async function findInRegistry(
  sourceRepo: string,
): Promise<RegistryEntry | undefined> {
  const registry = await loadRegistry()
  return registry.workspaces.find(
    (w) => w.sourceRepo === sourceRepo,
  )
}
