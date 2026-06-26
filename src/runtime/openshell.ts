import { join } from 'pathe'
import type { RuntimeAdapter, LaunchSpec } from './types.js'

export const openshellAdapter: RuntimeAdapter = {
  type: 'openshell',

  buildLaunchSpec(configArgv: string[], sandboxPath: string): LaunchSpec {
    const [command, ...args] = configArgv
    return {
      command,
      args,
      cwd: sandboxPath,
      detached: true,
      stdoutLog: join(sandboxPath, '.sandbox', 'runtime.stdout.log'),
      stderrLog: join(sandboxPath, '.sandbox', 'runtime.stderr.log'),
    }
  },
}
