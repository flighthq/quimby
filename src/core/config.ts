import { resolve, dirname, join } from 'pathe'
import { fileURLToPath } from 'node:url'
import { ConfigError } from '../utils/errors.js'
import type { WorkspaceConfig } from '../types/config.js'
import { exists } from '../utils/fs.js'

const CONFIG_FILENAMES = [
  'ao.config.ts',
  'ao.config.mts',
  'ao.config.js',
  'ao.config.mjs',
]

async function getOwnIndexPath(): Promise<string> {
  const thisDir = dirname(fileURLToPath(import.meta.url))
  for (const name of ['index.mjs', 'index.js']) {
    const candidate = join(thisDir, name)
    if (await exists(candidate)) return candidate
  }
  return join(thisDir, 'index.js')
}

export async function loadConfig(repoPath: string): Promise<WorkspaceConfig> {
  const { createJiti } = await import('jiti')
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: false,
    alias: {
      'agent-orchestrator': await getOwnIndexPath(),
    },
  })

  for (const filename of CONFIG_FILENAMES) {
    const configPath = resolve(repoPath, filename)
    if (!(await exists(configPath))) continue

    const mod = await jiti.import(configPath, { default: true })
    const config = (mod as Record<string, unknown>).default ?? mod
    validateConfig(config, configPath)
    return config as WorkspaceConfig
  }

  throw new ConfigError(
    `No ao config file found in ${repoPath}. ` +
    `Expected one of: ${CONFIG_FILENAMES.join(', ')}`,
  )
}

function validateConfig(
  config: unknown,
  path: string,
): asserts config is WorkspaceConfig {
  if (!config || typeof config !== 'object') {
    throw new ConfigError(`Config at ${path} must export an object`)
  }
  const c = config as Record<string, unknown>

  if (!c.source || typeof c.source !== 'object') {
    throw new ConfigError(`Config at ${path} must have a "source" property`)
  }

  if (!c.sandboxes || typeof c.sandboxes !== 'object') {
    throw new ConfigError(`Config at ${path} must have a "sandboxes" property`)
  }

  for (const [name, sandbox] of Object.entries(
    c.sandboxes as Record<string, unknown>,
  )) {
    if (!sandbox || typeof sandbox !== 'object') {
      throw new ConfigError(`Sandbox "${name}" must be an object`)
    }
    const s = sandbox as Record<string, unknown>
    if (typeof s.role !== 'string') {
      throw new ConfigError(`Sandbox "${name}" must have a "role" string`)
    }
    if (!s.runtime || typeof s.runtime !== 'object') {
      throw new ConfigError(`Sandbox "${name}" must have a "runtime" object`)
    }
    const rt = s.runtime as Record<string, unknown>
    if (typeof rt.type !== 'string') {
      throw new ConfigError(
        `Sandbox "${name}" runtime must have a "type" string`,
      )
    }
    if (typeof rt.launch !== 'function') {
      throw new ConfigError(
        `Sandbox "${name}" runtime must have a "launch" function`,
      )
    }
  }
}
