import { afterEach, describe, expect, it, vi } from 'vitest'

const findRoot = vi.hoisted(() => vi.fn(async () => '/repo' as string | undefined))
const scaffoldQuimbyConfig = vi.hoisted(() => vi.fn(async () => '/repo/quimby.yaml'))

vi.mock('@quimbyhq/git', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  findRoot,
}))
vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  scaffoldQuimbyConfig,
}))

import cmd from './init'

afterEach(() => {
  findRoot.mockResolvedValue('/repo')
  scaffoldQuimbyConfig.mockClear()
})

describe('runInitCommand', () => {
  it('lists starters without scaffolding', async () => {
    await cmd.run!({ args: { list: true } } as never)
    expect(scaffoldQuimbyConfig).not.toHaveBeenCalled()
  })

  it('scaffolds a named starter non-interactively', async () => {
    await cmd.run!({ args: { starter: 'review-loop', force: false } } as never)
    expect(scaffoldQuimbyConfig).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        default: 'review-loop',
        layouts: { fleet: '@reviewer | @builder' },
      }),
      { force: false },
    )
  })

  it('passes --force through to the scaffolder', async () => {
    await cmd.run!({ args: { starter: 'solo', force: true } } as never)
    expect(scaffoldQuimbyConfig).toHaveBeenCalledWith('/repo', expect.anything(), { force: true })
  })

  it('rejects an unknown starter', async () => {
    await expect(cmd.run!({ args: { starter: 'nope' } } as never)).rejects.toThrow(
      'Unknown starter',
    )
  })

  it('throws when not in a git repository', async () => {
    findRoot.mockResolvedValueOnce(undefined)
    await expect(cmd.run!({ args: { starter: 'solo' } } as never)).rejects.toThrow('git repository')
  })
})
