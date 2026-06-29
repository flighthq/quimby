import type { LocalLocation } from './LocalLocation'
import type { SSHLocation } from './SSHLocation'

export type AgentLocation = LocalLocation | SSHLocation

export function isSSH(loc: AgentLocation | undefined): loc is SSHLocation {
  return loc?.type === 'ssh'
}
