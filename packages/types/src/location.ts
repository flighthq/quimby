export interface LocalLocation {
  type: 'local'
}

export interface SSHLocation {
  type: 'ssh'
  host: string // "user@host" or bare "host"
  port?: number
  base?: string // remote base dir; default: ~/.quimby/workspaces/<projectId>
}

export type WorkerLocation = LocalLocation | SSHLocation

export function isSSH(loc: WorkerLocation | undefined): loc is SSHLocation {
  return loc?.type === 'ssh'
}
