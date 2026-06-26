import { defineCommand } from 'citty'
import { join } from 'pathe'
import { resolveWorkspace } from '../../core/workspace.js'
import { getSandboxPath } from '../../utils/paths.js'
import { logger } from '../../utils/logger.js'
import { execa } from 'execa'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, exp)
  return `${value.toFixed(1)} ${units[exp]}`
}

async function getDirSize(path: string): Promise<number> {
  try {
    const { stdout } = await execa('du', ['-sb', path])
    return parseInt(stdout.split('\t')[0], 10)
  } catch {
    return 0
  }
}

export default defineCommand({
  meta: {
    name: 'size',
    description: 'Show disk usage per sandbox',
  },
  async run() {
    const { state, workspacePath } = await resolveWorkspace()

    logger.info(`Workspace: ${state.name}`)
    logger.info(`Path: ${workspacePath}\n`)

    let totalSize = 0
    const rows: Array<{ Sandbox: string; Size: string; Runtime: string }> = []

    for (const sandboxState of Object.values(state.sandboxes)) {
      if (sandboxState.host) {
        rows.push({
          Sandbox: sandboxState.name,
          Size: '(remote)',
          Runtime: sandboxState.runtimeType,
        })
        continue
      }

      const sandboxPath = getSandboxPath(workspacePath, sandboxState.name)
      const size = await getDirSize(sandboxPath)
      totalSize += size

      rows.push({
        Sandbox: sandboxState.name,
        Size: formatBytes(size),
        Runtime: sandboxState.runtimeType,
      })
    }

    console.table(rows)
    logger.info(`Total local: ${formatBytes(totalSize)}`)
  },
})
