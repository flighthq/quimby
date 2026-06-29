import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => {
    throw new Error('No quimby workspace found')
  }),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./serve')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when workspace is missing', async () => {
    const { default: cmd } = await import('./serve')
    await expect(cmd.run!({ args: {} } as never)).rejects.toThrow()
  })
})
