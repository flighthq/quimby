import { QuimbyError } from '@quimbyhq/errors'
import { describe, expect, it, vi } from 'vitest'

let resolved: unknown

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => {
    if (resolved instanceof Error) throw resolved
    return resolved
  }),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./diff')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when workspace is missing', async () => {
    resolved = new Error('No quimby workspace found')
    const { default: cmd } = await import('./diff')
    await expect(cmd.run!({ args: { name: 'alice', stat: false } } as never)).rejects.toThrow()
  })

  it('throws a QuimbyError with the standard wording for an unknown agent', async () => {
    // Resolves a workspace with no matching agent, so getDiff hits the not-found guard before
    // touching git — the guard must throw QuimbyError (like every other command), not a bare Error.
    resolved = { state: { id: 'p', agents: {} }, repoRoot: '/fake/root' }
    const { default: cmd } = await import('./diff')
    await expect(
      cmd.run!({ args: { name: 'ghost', stat: false } } as never),
    ).rejects.toBeInstanceOf(QuimbyError)
    await expect(cmd.run!({ args: { name: 'ghost', stat: false } } as never)).rejects.toThrow(
      'Agent "ghost" not found',
    )
  })
})
