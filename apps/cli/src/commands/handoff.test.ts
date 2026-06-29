import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', agents: { review: { location: undefined } }, subscriptions: {} },
    repoRoot: '/fake/root',
  })),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./handoff')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when the recipient agent does not exist (host → unknown)', async () => {
    const { default: cmd } = await import('./handoff')
    await expect(
      cmd.run!({
        args: { from: 'ghost', rebase: false, 'skip-guard': false, 'no-verify': false },
      } as never),
    ).rejects.toThrow('not found')
  })

  it('throws when the source agent does not exist (unknown → review)', async () => {
    const { default: cmd } = await import('./handoff')
    await expect(
      cmd.run!({
        args: {
          from: 'ghost',
          to: 'review',
          rebase: false,
          'skip-guard': false,
          'no-verify': false,
        },
      } as never),
    ).rejects.toThrow('not found')
  })
})
