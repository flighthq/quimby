import { describe, expect, it, vi } from 'vitest'

const saveMergeModeDefault = vi.hoisted(() => vi.fn(async () => '/repo/.quimby/local.yaml'))
const loadQuimbyConfig = vi.hoisted(() => vi.fn(async () => ({}) as Record<string, unknown>))
const infos = vi.hoisted(() => [] as string[])
const successes = vi.hoisted(() => [] as string[])

vi.mock('@quimbyhq/git', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  findRoot: vi.fn(async () => '/repo'),
}))
vi.mock('@quimbyhq/utils', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  logger: {
    info: (m: string) => infos.push(m),
    success: (m: string) => successes.push(m),
    warn: () => {},
  },
}))
vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  saveMergeModeDefault,
  loadQuimbyConfig,
}))

import { runMergeModeCommand } from './merge-mode'

describe('runMergeModeCommand', () => {
  it('shows the built-in default when none is configured', async () => {
    infos.length = 0
    loadQuimbyConfig.mockResolvedValueOnce({})
    await runMergeModeCommand({ args: {} })
    expect(infos.join('\n')).toContain('squashed (built-in default')
  })

  it('shows the configured default when set', async () => {
    infos.length = 0
    loadQuimbyConfig.mockResolvedValueOnce({ mergeMode: 'commits' })
    await runMergeModeCommand({ args: {} })
    expect(infos.join('\n')).toContain('Default merge mode: commits')
  })

  it('persists a valid mode to local config', async () => {
    saveMergeModeDefault.mockClear()
    successes.length = 0
    await runMergeModeCommand({ args: { mode: 'commits' } })
    expect(saveMergeModeDefault).toHaveBeenCalledWith('/repo', 'commits', { global: undefined })
    expect(successes.join('\n')).toContain('commits')
  })

  it('persists to user config with --global', async () => {
    saveMergeModeDefault.mockClear()
    await runMergeModeCommand({ args: { mode: 'patch', global: true } })
    expect(saveMergeModeDefault).toHaveBeenCalledWith('/repo', 'patch', { global: true })
  })

  it('rejects an invalid mode without persisting', async () => {
    saveMergeModeDefault.mockClear()
    await expect(runMergeModeCommand({ args: { mode: 'bogus' } })).rejects.toThrow(/invalid/i)
    expect(saveMergeModeDefault).not.toHaveBeenCalled()
  })
})
