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
    state: { id: 'proj-id', agents: { review: { location: undefined } }, subscriptions: {} },
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

describe('run', () => {
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

  it('nudges the recipient with the returned text when nudgeText is set', async () => {
    handoffWork.mockResolvedValueOnce({ to: 'review', nudgeText: 'inbox: review this' } as never)
    const { default: cmd } = await import('./handoff')
    await cmd.run!({ args: { from: 'review', rebase: false, clear: false } } as never)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(1)
    expect(nudgeAgentSession.mock.calls[0][0]).toMatchObject({
      displayName: 'review',
      text: 'inbox: review this',
    })
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
