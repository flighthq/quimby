import { afterEach, describe, expect, it, vi } from 'vitest'

const findRoot = vi.hoisted(() => vi.fn(async () => undefined as string | undefined))
const addAgent = vi.hoisted(() =>
  vi.fn(async (_repoRoot: string, name: string, opts: object) => ({
    id: 'a1',
    name,
    seedCommit: '1234567890',
    ...opts,
  })),
)

vi.mock('@quimbyhq/git', async (importOriginal) => {
  const actual = (await importOriginal()) as object
  return { ...actual, findRoot }
})

vi.mock('@quimbyhq/agent', () => ({ addAgent }))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  loadQuimbyConfig: vi.fn(async () => ({
    defaults: { runtime: 'local', entrypoint: 'claude' },
    roles: {
      builder: {
        runtimeProfile: 'sbxClaude',
        runtime: 'sbx',
        entrypoint: 'codex --model "gpt 5"',
        check: { command: 'npm run ci', verifyByDefault: true },
        syncRef: 'main',
        tmux: true,
      },
    },
    hosts: {
      gpu: { host: 'me@gpu', port: 2222, base: '/srv/quimby' },
    },
  })),
}))

import cmd from './add'

afterEach(() => {
  findRoot.mockResolvedValue(undefined)
  addAgent.mockClear()
})

describe('run', () => {
  it('is a function', () => {
    expect(typeof cmd.run).toBe('function')
  })

  it('throws QuimbyError when not in a git repo', async () => {
    await expect(cmd.run!({ args: { agent: 'alice' } } as never)).rejects.toThrow(
      'Not inside a git repository',
    )
  })

  it('creates an agent from a role and private host alias', async () => {
    findRoot.mockResolvedValueOnce('/repo')
    await cmd.run!({ args: { agent: 'builder', role: 'builder', hostAlias: 'gpu' } } as never)
    expect(addAgent).toHaveBeenCalledWith('/repo', 'builder', {
      role: 'builder',
      defaults: {
        runtimeProfile: 'sbxClaude',
        runtime: 'sbx',
        entrypoint: 'codex --model "gpt 5"',
      },
      location: { type: 'ssh', alias: 'gpu' },
      syncRef: 'main',
      tmux: true,
      check: 'npm run ci',
      verifyByDefault: true,
    })
  })

  it('lets explicit flags override role defaults', async () => {
    findRoot.mockResolvedValueOnce('/repo')
    await cmd.run!({
      args: { agent: 'builder', role: 'builder', runtime: 'local', cmd: 'claude' },
    } as never)
    expect(addAgent).toHaveBeenCalledWith(
      '/repo',
      'builder',
      expect.objectContaining({
        defaults: { runtime: 'local', entrypoint: 'claude' },
      }),
    )
  })

  it('lets --runtime-profile override role defaults', async () => {
    findRoot.mockResolvedValueOnce('/repo')
    await cmd.run!({
      args: { agent: 'builder', role: 'builder', runtimeProfile: 'openshellOllama' },
    } as never)
    expect(addAgent).toHaveBeenCalledWith(
      '/repo',
      'builder',
      expect.objectContaining({
        defaults: expect.objectContaining({ runtimeProfile: 'openshellOllama' }),
      }),
    )
  })

  it('does not alias --cmd to -c, keeping -c reserved for --clear', () => {
    expect((cmd.args as Record<string, { alias?: string }>).cmd.alias).toBeUndefined()
  })
})
