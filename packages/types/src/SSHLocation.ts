export interface SSHLocation {
  type: 'ssh'
  host: string // "user@host" or bare "host"
  port?: number
  base?: string // remote base dir; default: ~/.quimby/workspaces/<projectId>
}
