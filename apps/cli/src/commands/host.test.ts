import { describe, expect, it, vi } from 'vitest'

const saveHostAliasBinding = vi.hoisted(() => vi.fn(async () => '/repo/.quimby/local.yaml'))
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
  saveHostAliasBinding,
  loadQuimbyConfig: vi.fn(async () => ({
    hosts: {
      remote: { type: 'ssh', host: 'remote' }, // unbound (self-referential placeholder)
      gpu: { type: 'ssh', host: 'me@gpu', port: 2222 }, // bound
    },
  })),
}))

import { runHostCommand } from './host'

describe('runHostCommand', () => {
  it('lists aliases with bound/unbound status', async () => {
    infos.length = 0
    await runHostCommand({ args: {} })
    const out = infos.join('\n')
    expect(out).toContain('gpu')
    expect(out).toContain('me@gpu:2222')
    expect(out).toContain('remote')
    expect(out).toContain('unbound')
  })

  it('binds an alias non-interactively with --set', async () => {
    saveHostAliasBinding.mockClear()
    successes.length = 0
    await runHostCommand({ args: { alias: 'remote', set: 'me@box:/srv', port: '2200' } })
    expect(saveHostAliasBinding).toHaveBeenCalledWith(
      '/repo',
      'remote',
      { host: 'me@box', base: '/srv', port: 2200 },
      { global: undefined },
    )
    expect(successes.join('\n')).toContain('me@box')
  })

  it('prints the binding for a bound alias', async () => {
    infos.length = 0
    await runHostCommand({ args: { alias: 'gpu' } })
    expect(infos.join('\n')).toContain('me@gpu:2222')
  })
})
