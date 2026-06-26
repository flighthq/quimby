import { join, basename, resolve } from 'pathe'
import { ensureDir, exists } from '../utils/fs.js'
import { readYaml, writeYaml } from '../utils/yaml.js'
import * as git from '../utils/git.js'
import { getWorkspacesDir, getWorkspacePath } from '../utils/paths.js'
import { loadConfig } from './config.js'
import { addToRegistry, loadRegistry } from './registry.js'
import { scaffoldSandbox, scaffoldRemoteSandbox } from './sandbox.js'
import { RemoteTransport } from './transport/remote.js'
import { AoError } from '../utils/errors.js'
import type { WorkspaceConfig } from '../types/config.js'
import type { WorkspaceState } from '../types/workspace.js'

export async function createWorkspace(repoPath: string): Promise<{
  state: WorkspaceState
  config: WorkspaceConfig
  workspacePath: string
}> {
  const absRepoPath = resolve(repoPath)
  const config = await loadConfig(absRepoPath)

  const sourceRepo =
    (await git.getRemoteUrl(absRepoPath)) ?? absRepoPath
  const snapshot = await git.getCurrentRef(absRepoPath)
  const name = config.name ?? basename(absRepoPath)
  const workspacePath = getWorkspacePath(name)

  if (await exists(workspacePath)) {
    throw new AoError(
      `Workspace "${name}" already exists at ${workspacePath}. ` +
      `Remove it first or use a different name.`,
    )
  }

  await ensureDir(workspacePath)
  await git.init(workspacePath)

  const sandboxStates: Record<string, Awaited<ReturnType<typeof scaffoldSandbox>>> = {}

  for (const [sandboxName, sandboxConfig] of Object.entries(config.sandboxes)) {
    if (sandboxConfig.runtime.type === 'remote' && sandboxConfig.runtime.host && sandboxConfig.runtime.user) {
      const remotePath = `/home/${sandboxConfig.runtime.user}/.ao/sandboxes/${name}/${sandboxName}`
      const transport = new RemoteTransport(
        remotePath,
        sandboxConfig.runtime.host,
        sandboxConfig.runtime.user,
        sandboxConfig.runtime.port,
      )

      sandboxStates[sandboxName] = await scaffoldRemoteSandbox({
        sandboxName,
        sourceRepo: absRepoPath,
        sourceRef: config.source.ref,
        config: sandboxConfig,
        transport,
      })
      sandboxStates[sandboxName].remotePath = remotePath
    } else {
      sandboxStates[sandboxName] = await scaffoldSandbox({
        workspacePath,
        sandboxName,
        sourceRepo: absRepoPath,
        sourceRef: config.source.ref,
        config: sandboxConfig,
      })
    }
  }

  const state: WorkspaceState = {
    name,
    sourceRepo,
    sourceRef: config.source.ref,
    snapshot,
    createdAt: new Date().toISOString(),
    sandboxes: sandboxStates,
  }

  await writeYaml(join(workspacePath, 'workspace.yaml'), state)

  await addToRegistry({
    name,
    sourceRepo,
    path: workspacePath,
    createdAt: state.createdAt,
  })

  return { state, config, workspacePath }
}

export async function resolveWorkspace(): Promise<{
  state: WorkspaceState
  workspacePath: string
}> {
  const cwd = process.cwd()
  const workspacesDir = getWorkspacesDir()

  if (cwd.startsWith(workspacesDir)) {
    const rel = cwd.slice(workspacesDir.length + 1)
    const name = rel.split('/')[0]
    const workspacePath = getWorkspacePath(name)
    const state = await readYaml<WorkspaceState>(
      join(workspacePath, 'workspace.yaml'),
    )
    return { state, workspacePath }
  }

  const repoRoot = await git.findRoot(cwd)
  if (repoRoot) {
    const remoteUrl = await git.getRemoteUrl(repoRoot)
    const registry = await loadRegistry()
    const entry = registry.workspaces.find(
      (w) => w.sourceRepo === (remoteUrl ?? repoRoot),
    )
    if (entry) {
      const state = await readYaml<WorkspaceState>(
        join(entry.path, 'workspace.yaml'),
      )
      return { state, workspacePath: entry.path }
    }
  }

  throw new AoError(
    'Cannot determine workspace. Run from within a workspace ' +
    'directory or a repo initialized with `ao init`.',
  )
}

export async function loadWorkspaceState(
  workspacePath: string,
): Promise<WorkspaceState> {
  return readYaml<WorkspaceState>(join(workspacePath, 'workspace.yaml'))
}

export async function saveWorkspaceState(
  workspacePath: string,
  state: WorkspaceState,
): Promise<void> {
  await writeYaml(join(workspacePath, 'workspace.yaml'), state)
}
