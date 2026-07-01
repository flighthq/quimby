import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => {
    throw new Error('No quimby workspace found')
  }),
}))

describe('runMergeCommand', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./merge')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when workspace is missing', async () => {
    const { default: cmd } = await import('./merge')
    await expect(
      cmd.run!({ args: { agent: 'alice', commits: false, patch: false } } as never),
    ).rejects.toThrow()
  })
})
