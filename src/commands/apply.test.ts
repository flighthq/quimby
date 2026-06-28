import { describe, expect, it, vi } from 'vitest'

vi.mock('../core/workspace', () => ({
  resolveWorkspace: vi.fn(async () => {
    throw new Error('No quimby workspace found')
  }),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./apply')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when workspace is missing', async () => {
    const { default: cmd } = await import('./apply')
    await expect(
      cmd.run!({ args: { pack: 'alice-1', commits: false, patch: false } } as never),
    ).rejects.toThrow()
  })
})
