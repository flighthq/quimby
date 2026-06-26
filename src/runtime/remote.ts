import type { RuntimeAdapter, LaunchSpec } from './types.js'

export const remoteAdapter: RuntimeAdapter = {
  type: 'remote',

  buildLaunchSpec(configArgv: string[], sandboxPath: string): LaunchSpec {
    const [command, ...args] = configArgv
    return {
      command,
      args,
      cwd: sandboxPath,
      detached: true,
    }
  },
}
