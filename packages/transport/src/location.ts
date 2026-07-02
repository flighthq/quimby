import type { AgentLocation, SSHLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'

/**
 * Split a host spec into its connection host and optional remote base path. A spec is
 * `user@host` or `user@host:/remote/path` — the `:/` (never a plain `:`, which is part
 * of an `ssh://` or a Windows path) separates the base. Pure string parsing.
 */
export function parseSSHHostSpec(spec: string): { host: string; base?: string } {
  const colonSlash = spec.indexOf(':/')
  if (colonSlash < 0) return { host: spec }
  return { host: spec.slice(0, colonSlash), base: spec.slice(colonSlash + 1) }
}

/** Build a fresh SSHLocation from a host spec plus optional port (used by `add`). */
export function buildSSHLocation(spec: string, port?: number): SSHLocation {
  const { host, base } = parseSSHHostSpec(spec)
  return { type: 'ssh', host, ...(port ? { port } : {}), ...(base ? { base } : {}) }
}

/**
 * Apply a partial SSH update to an agent's current location (used by `set`): a new host
 * spec overrides host+base, a new port overrides port, and any field left unspecified is
 * kept from the current SSH location. Returns null when no host can be resolved (neither
 * given nor already present), so the caller can report "no SSH host".
 *
 * Unlike the earlier inline logic in `set`, updating only the port keeps the existing
 * base path instead of silently dropping it.
 */
export function mergeSSHLocation(
  current: AgentLocation | undefined,
  updates: { hostSpec?: string; port?: number },
): SSHLocation | null {
  const cur = current && isSSH(current) ? current : undefined
  const parsed = updates.hostSpec ? parseSSHHostSpec(updates.hostSpec) : undefined

  const host = parsed?.host ?? cur?.host
  if (!host) return null

  const base = parsed ? parsed.base : cur?.base
  const port = updates.port ?? cur?.port
  return { type: 'ssh', host, ...(port ? { port } : {}), ...(base ? { base } : {}) }
}
