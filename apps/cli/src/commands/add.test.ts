import { describe, expect, it, vi } from 'vitest'

import cmd from './add'

vi.mock('@quimby/core', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, git: { ...actual.git, findRoot: vi.fn(async () => undefined) } }
})

describe('run', () => {
  it('is a function', () => {
    expect(typeof cmd.run).toBe('function')
  })

  it('throws QuimbyError when not in a git repo', async () => {
    await expect(cmd.run!({ args: { name: 'alice' } } as never)).rejects.toThrow(
      'Not inside a git repository',
    )
  })
})
