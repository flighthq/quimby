import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadConfig } from '../../src/core/config.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-config-test-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('loads a valid ao.config.ts', async () => {
    await writeFile(
      join(tmp, 'ao.config.ts'),
      `
      export default {
        source: { ref: 'main' },
        sandboxes: {
          backend: {
            role: 'Backend dev',
            runtime: { type: 'docker-sandbox', launch: () => ['sbx', 'run'] },
          },
        },
      }
      `,
    )

    const config = await loadConfig(tmp)
    expect(config.source.ref).toBe('main')
    expect(config.sandboxes.backend.role).toBe('Backend dev')
  })

  it('throws when no config file exists', async () => {
    await expect(loadConfig(tmp)).rejects.toThrow('No ao config file found')
  })

  it('throws when config is missing source', async () => {
    await writeFile(
      join(tmp, 'ao.config.ts'),
      `export default { sandboxes: {} }`,
    )
    await expect(loadConfig(tmp)).rejects.toThrow('source')
  })

  it('throws when config is missing sandboxes', async () => {
    await writeFile(
      join(tmp, 'ao.config.ts'),
      `export default { source: { ref: 'main' } }`,
    )
    await expect(loadConfig(tmp)).rejects.toThrow('sandboxes')
  })

  it('throws when sandbox is missing role', async () => {
    await writeFile(
      join(tmp, 'ao.config.ts'),
      `export default {
        source: { ref: 'main' },
        sandboxes: { bad: { runtime: { type: 'docker-sandbox', launch: () => [] } } }
      }`,
    )
    await expect(loadConfig(tmp)).rejects.toThrow('role')
  })

  it('throws when sandbox runtime is missing launch', async () => {
    await writeFile(
      join(tmp, 'ao.config.ts'),
      `export default {
        source: { ref: 'main' },
        sandboxes: { bad: { role: 'Test', runtime: { type: 'docker-sandbox' } } }
      }`,
    )
    await expect(loadConfig(tmp)).rejects.toThrow('launch')
  })
})
