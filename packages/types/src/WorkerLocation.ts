import type { LocalLocation } from './LocalLocation'
import type { SSHLocation } from './SSHLocation'

export type WorkerLocation = LocalLocation | SSHLocation

export function isSSH(loc: WorkerLocation | undefined): loc is SSHLocation {
  return loc?.type === 'ssh'
}
