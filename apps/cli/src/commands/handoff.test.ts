import { resolve } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'

const handoffWork = vi.hoisted(() => vi.fn())
const nudgeAgentSession = vi.hoisted(() => vi.fn(async (_opts: Record<string, unknown>) => {}))
const getAgentAttestation = vi.hoisted(() => vi.fn(async () => null))

// Keep the rest of @quimbyhq/agent real; only stub the attestation read so we can drive a
// `result: fail` and assert delivery still proceeds (warn-never-gate).
vi.mock('@quimbyhq/agent', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getAgentAttestation,
}))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', agents: { review: { location: undefined } } },
    repoRoot: '/fake/root',
  })),
}))
// Default handoffWork to the real implementation so the existing "not found" validation
// tests keep exercising real behavior; behavioral tests override per-call.
vi.mock('@quimbyhq/handoff', async (importOriginal) => {
  const actual = (await importOriginal()) as { handoffWork: typeof handoffWork }
  handoffWork.mockImplementation(actual.handoffWork as never)
  return { ...actual, handoffWork }
})
vi.mock('@quimbyhq/session', () => ({ nudgeAgentSession }))

afterEach(() => {
  vi.clearAllMocks()
})

describe('runHandoffCommand', () => {
  it('passes --file through as absolute paths, one or many', async () => {
    // citty yields a bare string for one `--file` and an array for several; resolving against cwd
    // keeps a relative path meaning what the operator typed, not what the repo root is.
    handoffWork.mockResolvedValueOnce({
      from: 'host',
      to: 'review',
      parcelName: 'p',
      nudgeText: null,
    })
    const { default: cmd } = await import('./handoff')
    await cmd.run!({ args: { from: 'review', file: 'notes.csv', rebase: false } } as never)
    expect(handoffWork.mock.calls[0][0].files).toEqual([resolve('notes.csv')])

    handoffWork.mockResolvedValueOnce({
      from: 'host',
      to: 'review',
      parcelName: 'p',
      nudgeText: null,
    })
    await cmd.run!({
      args: { from: 'review', file: ['a.bin', '/abs/b.bin'], rebase: false },
    } as never)
    expect(handoffWork.mock.calls[1][0].files).toEqual([resolve('a.bin'), '/abs/b.bin'])
  })

  it('sends no files when none are attached', async () => {
    handoffWork.mockResolvedValueOnce({
      from: 'host',
      to: 'review',
      parcelName: 'p',
      nudgeText: null,
    })
    const { default: cmd } = await import('./handoff')
    await cmd.run!({ args: { from: 'review', rebase: false } } as never)
    expect(handoffWork.mock.calls[0][0].files).toEqual([])
  })

  it('maps --no-code to a note-only carry, so an attachment does not drag host work along', async () => {
    handoffWork.mockResolvedValueOnce({
      from: 'host',
      to: 'review',
      parcelName: 'p',
      nudgeText: null,
    })
    const { default: cmd } = await import('./handoff')
    await cmd.run!({ args: { from: 'review', code: false, file: 'x.bin', rebase: false } } as never)
    expect(handoffWork.mock.calls[0][0].noteOnly).toBe(true)

    handoffWork.mockResolvedValueOnce({
      from: 'host',
      to: 'review',
      parcelName: 'p',
      nudgeText: null,
    })
    await cmd.run!({ args: { from: 'review', code: true, rebase: false } } as never)
    expect(handoffWork.mock.calls[1][0].noteOnly).toBe(false)
  })

  it('is a function', async () => {
    const { default: cmd } = await import('./handoff')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when the recipient agent does not exist (host → unknown)', async () => {
    const { default: cmd } = await import('./handoff')
    await expect(
      cmd.run!({
        args: { from: 'ghost', rebase: false },
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
        },
      } as never),
    ).rejects.toThrow('not found')
  })

  it('nudge is an optional boolean with no default (auto: nudge only when a note is present)', async () => {
    const { default: cmd } = await import('./handoff')
    const args = cmd.args as Record<string, { type: string; default?: unknown }>
    expect(args.nudge.type).toBe('boolean')
    expect(args.nudge.default).toBeUndefined()
  })

  it('nudges the recipient with a courier notice naming the sender when nudgeText is set', async () => {
    handoffWork.mockResolvedValueOnce({
      from: 'host',
      to: 'review',
      parcelName: 'host-abc123',
      nudgeText: 'inbox: review this',
      userDirected: true,
    } as never)
    const { default: cmd } = await import('./handoff')
    await cmd.run!({
      args: { from: 'review', message: 'review this', rebase: false, clear: false },
    } as never)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(1)
    // nudgeText being non-null is the gate; the courier names the exact parcel to open first.
    expect(nudgeAgentSession.mock.calls[0][0]).toMatchObject({
      displayName: 'review',
      courier: 'delegated task host-abc123 from host',
    })
    expect(handoffWork).toHaveBeenCalledWith(
      expect.objectContaining({ userDirected: true }),
      expect.anything(),
    )
    // The reporter is threaded through to the session layer.
    expect((nudgeAgentSession.mock.calls[0][0] as { reporter: unknown }).reporter).toBeDefined()
  })

  it('does not nudge when nudgeText is null', async () => {
    handoffWork.mockResolvedValueOnce({ to: 'review', nudgeText: null } as never)
    const { default: cmd } = await import('./handoff')
    await cmd.run!({ args: { from: 'review', rebase: false, clear: false } } as never)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })

  it('delivers despite a failing attestation — informational, never a gate', async () => {
    getAgentAttestation.mockResolvedValueOnce({ command: 'npm run ci', result: 'fail' } as never)
    handoffWork.mockResolvedValueOnce({ to: 'review', nudgeText: null } as never)
    const { default: cmd } = await import('./handoff')
    await cmd.run!({ args: { from: 'review', rebase: false, clear: false } } as never)
    // The carry still happened even though the source attested `result: fail`.
    expect(handoffWork).toHaveBeenCalledTimes(1)
  })
})
