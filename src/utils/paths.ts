import { join } from 'pathe'

export function getQuimbyDir(repoRoot: string): string {
  return join(repoRoot, '.quimby')
}

export function getStatePath(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'state.yaml')
}

export function getWorkersDir(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'workers')
}

export function getWorkerDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'workers', name)
}

export function getWorkerRepoDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'workers', name, 'repo')
}

export function getPacksDir(repoRoot: string): string {
  return join(repoRoot, '.quimby', 'packs')
}

export function getPackDir(repoRoot: string, name: string): string {
  return join(repoRoot, '.quimby', 'packs', name)
}
