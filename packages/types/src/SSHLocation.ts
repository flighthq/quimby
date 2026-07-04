export interface SSHLocation {
  type: 'ssh'
  /**
   * Resolved connection target — "user@host" or bare "host". Absent when the
   * location carries only an unresolved `alias` whose concrete address is bound
   * from layered config at launch time (see `resolveSSHConnection`).
   */
  host?: string
  /**
   * Host-alias name resolved from layered quimby config at launch. Storing the
   * alias (rather than a flattened address) keeps the indirection alive, so a
   * private binding — or a later rebinding — propagates to the agent without
   * re-creating it. A legacy `host` that equals a declared alias name is treated
   * as an implicit alias for backward compatibility.
   */
  alias?: string
  port?: number
  base?: string // remote base dir; default: ~/.quimby/workspaces/<projectId>
}

/** An SSH location whose `host` is bound and ready to open a transport against. */
export function isResolvedSSHLocation(loc: SSHLocation): loc is SSHLocation & { host: string } {
  return typeof loc.host === 'string' && loc.host.length > 0
}
