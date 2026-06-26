import { getSandboxPath } from '../../utils/paths.js'
import { LocalTransport } from './local.js'
import { RemoteTransport } from './remote.js'
import type { SandboxTransport } from './types.js'
import type { SandboxState } from '../../types/workspace.js'

export type { SandboxTransport, ExecResult } from './types.js'
export { LocalTransport } from './local.js'
export { RemoteTransport } from './remote.js'

export function createTransport(
  workspacePath: string,
  sandbox: SandboxState,
): SandboxTransport {
  if (sandbox.host && sandbox.user && sandbox.remotePath) {
    return new RemoteTransport(
      sandbox.remotePath,
      sandbox.host,
      sandbox.user,
      sandbox.port,
    )
  }
  return new LocalTransport(getSandboxPath(workspacePath, sandbox.name))
}
