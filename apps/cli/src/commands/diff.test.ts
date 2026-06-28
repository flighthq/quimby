import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/core', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => {
    throw new Error('No quimby workspace found')
  }),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./diff')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when workspace is missing', async () => {
    const { default: cmd } = await import('./diff')
    await expect(cmd.run!({ args: { name: 'alice', stat: false } } as never)).rejects.toThrow()
  })
})
