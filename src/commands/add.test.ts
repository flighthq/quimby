import { describe, expect, it, vi } from 'vitest'

import cmd from './add'

vi.mock('../utils/git', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    findRoot: vi.fn(async () => undefined),
  }
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
