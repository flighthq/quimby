import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getProjectConfigPath } from '@quimbyhq/paths'
import type { QuimbyConfig } from '@quimbyhq/types'
import { exists, readYaml } from '@quimbyhq/utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildStarterConfig,
  listBoundHostAliases,
  listRuntimeProfiles,
  listStarters,
  scaffoldQuimbyConfig,
  shareableProfileShape,
} from './starters'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quimby-starter-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('buildStarterConfig', () => {
  it('builds a solo starter with one local agent and a default preset', () => {
    const config = buildStarterConfig('solo')
    expect(config.roles).toEqual({ dev: { runtimeProfile: 'claude' } })
    expect(config.runtimeProfiles).toEqual({ claude: { runtime: 'local', entrypoint: 'claude' } })
    expect(config.presets?.solo).toEqual({ agents: { dev: { role: 'dev' } } })
    expect(config.default).toBe('solo')
  })

  it('builds a review-loop with the chosen engine, builder count, and a referenced host alias', () => {
    const config = buildStarterConfig('review-loop', {
      engine: 'sbx-codex',
      builderCount: 2,
      hostAlias: 'remote',
    })
    expect(config.runtimeProfiles).toEqual({ 'sbx-codex': { runtime: 'sbx', entrypoint: 'codex' } })
    expect(config.roles?.builder).toEqual({ runtimeProfile: 'sbx-codex' })
    // The alias is declared unbound (address stays private) and referenced by the agents.
    expect(config.hosts).toEqual({ remote: {} })
    expect(config.presets?.['review-loop']?.agents).toEqual({
      builder: { role: 'builder', hostAlias: 'remote', count: 2 },
      reviewer: { role: 'reviewer', hostAlias: 'remote' },
    })
    expect(config.layouts?.fleet).toBe('@reviewer | @builder')
    expect(config.default).toBe('review-loop')
  })

  it('defaults the fleet starter to several builders', () => {
    const config = buildStarterConfig('fleet')
    expect(config.presets?.fleet?.agents).toMatchObject({ builder: { count: 3 } })
  })

  it('reuses a user profile by reference, inlining only its shareable shape', () => {
    const config = buildStarterConfig('solo', {
      reuseProfile: {
        name: 'my-codex',
        // Private fills (provider/env/model) must not reach the tracked file.
        profile: {
          runtime: 'sbx',
          entrypoint: 'codex',
          provider: 'https://secret.internal',
          env: { API_KEY: 'shh' },
          model: 'gpt-5',
        },
      },
    })
    expect(config.roles?.dev).toEqual({ runtimeProfile: 'my-codex' })
    expect(config.runtimeProfiles).toEqual({ 'my-codex': { runtime: 'sbx', entrypoint: 'codex' } })
  })
})

describe('listBoundHostAliases', () => {
  it('returns only aliases with a concrete address bound', () => {
    const config: QuimbyConfig = {
      hosts: { gpu: { host: 'me@gpu', port: 2222 }, remote: {}, self: { host: 'self' } },
    }
    expect(listBoundHostAliases(config)).toEqual([{ name: 'gpu', host: 'me@gpu', port: 2222 }])
  })
})

describe('listRuntimeProfiles', () => {
  it('lists declared runtime profiles with their configs', () => {
    expect(
      listRuntimeProfiles({
        runtimeProfiles: { 'codex-sbx': { runtime: 'sbx', entrypoint: 'codex' } },
      }),
    ).toEqual([{ name: 'codex-sbx', profile: { runtime: 'sbx', entrypoint: 'codex' } }])
  })
})

describe('listStarters', () => {
  it('lists the built-in starters', () => {
    expect(listStarters().map((s) => s.name)).toEqual(['solo', 'review-loop', 'fleet'])
  })
})

describe('scaffoldQuimbyConfig', () => {
  it('writes the config to the tracked quimby.yaml and returns its path', async () => {
    const config = buildStarterConfig('solo')
    const path = await scaffoldQuimbyConfig(dir, config)
    expect(path).toBe(getProjectConfigPath(dir))
    expect(await exists(path)).toBe(true)
    expect(await readYaml<QuimbyConfig>(path)).toEqual(config)
  })

  it('refuses to overwrite an existing quimby.yaml without force', async () => {
    await scaffoldQuimbyConfig(dir, buildStarterConfig('solo'))
    await expect(scaffoldQuimbyConfig(dir, buildStarterConfig('fleet'))).rejects.toThrow(
      'already exists',
    )
  })

  it('overwrites with force', async () => {
    await scaffoldQuimbyConfig(dir, buildStarterConfig('solo'))
    const path = await scaffoldQuimbyConfig(dir, buildStarterConfig('fleet'), { force: true })
    expect((await readYaml<QuimbyConfig>(path)).default).toBe('fleet')
  })
})

describe('shareableProfileShape', () => {
  it('keeps runtime and entrypoint, dropping secret/machine fills', () => {
    expect(
      shareableProfileShape({
        runtime: 'sbx',
        entrypoint: 'codex',
        provider: 'https://secret',
        env: { API_KEY: 'shh' },
        model: 'gpt-5',
        ollama: { host: 'http://gpu:11434' },
      }),
    ).toEqual({ runtime: 'sbx', entrypoint: 'codex' })
  })
})
