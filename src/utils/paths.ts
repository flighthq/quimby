import { join } from 'pathe'
import { homedir } from 'node:os'

export function getAoHome(): string {
  return process.env.AO_HOME ?? join(homedir(), '.ao')
}

export function getWorkspacesDir(): string {
  return join(getAoHome(), 'workspaces')
}

export function getRegistryPath(): string {
  return join(getAoHome(), 'workspaces.yaml')
}

export function getWorkspacePath(name: string): string {
  return join(getWorkspacesDir(), name)
}

export function getSandboxPath(workspacePath: string, sandboxName: string): string {
  return join(workspacePath, 'sandboxes', sandboxName)
}

export function getSandboxRepoPath(workspacePath: string, sandboxName: string): string {
  return join(getSandboxPath(workspacePath, sandboxName), 'repo')
}

export function getSandboxMetaDir(workspacePath: string, sandboxName: string): string {
  return join(getSandboxPath(workspacePath, sandboxName), '.sandbox')
}

export function getBundlesDir(workspacePath: string, sandboxName: string): string {
  return join(getSandboxMetaDir(workspacePath, sandboxName), 'bundles')
}

export function getInboxDir(workspacePath: string, sandboxName: string): string {
  return join(getSandboxMetaDir(workspacePath, sandboxName), 'inbox')
}

export function getMessagesDir(workspacePath: string, sandboxName: string): string {
  return join(getSandboxMetaDir(workspacePath, sandboxName), 'messages')
}
