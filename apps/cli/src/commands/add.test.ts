import { describe, expect, it, vi } from 'vitest'

import cmd from './add'

vi.mock('@quimbyhq/git', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, findRoot: vi.fn(async () => undefined) }
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

  it('does not alias --cmd to -c, keeping -c reserved for --clear', () => {
    expect((cmd.args as Record<string, { alias?: string }>).cmd.alias).toBeUndefined()
  })
})
