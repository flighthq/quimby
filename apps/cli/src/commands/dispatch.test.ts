import { logger } from '@quimbyhq/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const dispatchOutboxes = vi.hoisted(() => vi.fn())
const nudgeAgentSession = vi.hoisted(() => vi.fn(async (_opts: Record<string, unknown>) => {}))

function workspace(agents: Record<string, unknown>) {
  return { state: { id: 'proj-id', agents }, repoRoot: '/fake/root' }
}

let resolved = workspace({})

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
}))
// Default dispatchOutboxes to the real implementation so the existing validation tests
// (not-found, --all required, empty) still exercise real behavior; behavioral tests
// override per-call. inboxNoticeText stays real (spread through).
vi.mock('@quimbyhq/handoff', async (importOriginal) => {
  const actual = (await importOriginal()) as { dispatchOutboxes: typeof dispatchOutboxes }
  dispatchOutboxes.mockImplementation(actual.dispatchOutboxes as never)
  return { ...actual, dispatchOutboxes }
})
vi.mock('@quimbyhq/session', () => ({ nudgeAgentSession }))

afterEach(() => {
  vi.clearAllMocks()
  resolved = workspace({})
})

describe('runDispatchCommand', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./dispatch')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when the agent does not exist', async () => {
    const { default: cmd } = await import('./dispatch')
    await expect(
      cmd.run!({
        args: { agent: 'ghost', all: false, rebase: false, nudge: true },
      } as never),
    ).rejects.toThrow('not found')
  })

  it('throws when neither an agent nor --all is given', async () => {
    const { default: cmd } = await import('./dispatch')
    await expect(
      cmd.run!({ args: { all: false, rebase: false, nudge: true } } as never),
    ).rejects.toThrow('--all')
  })

  it('with --all and no agents, reports nothing to do instead of throwing', async () => {
    const { default: cmd } = await import('./dispatch')
    await expect(
      cmd.run!({ args: { all: true, rebase: false, nudge: true } } as never),
    ).resolves.toBeUndefined()
  })

  it('exposes an --all flag to dispatch every outbox', async () => {
    const { default: cmd } = await import('./dispatch')
    const args = cmd.args as Record<string, { type: string; default?: boolean }>
    expect(args.all).toMatchObject({ type: 'boolean', default: false })
  })

  it('nudges running recipients over tmux by default (--no-nudge to skip)', async () => {
    const { default: cmd } = await import('./dispatch')
    const args = cmd.args as Record<string, { type: string; default?: boolean }>
    expect(args.nudge).toMatchObject({ type: 'boolean', default: true })
  })

  it('nudges the recipient of a delivered parcel when --nudge is on', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder' } })
    dispatchOutboxes.mockResolvedValueOnce({
      senders: [
        {
          sender: 'review',
          results: [
            {
              status: 'delivered',
              recipient: 'builder',
              parcelName: 'review-abc',
              userDirected: true,
            },
          ],
        },
      ],
      totalQueued: 1,
    } as never)
    vi.spyOn(logger, 'success').mockImplementation(() => {})
    const { default: cmd } = await import('./dispatch')
    await cmd.run!({ args: { agent: 'review', all: false, rebase: false, nudge: true } } as never)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(1)
    // Courier notice names the exact parcel and sender; the session layer prepends `quimby ·`.
    expect(nudgeAgentSession.mock.calls[0][0]).toMatchObject({
      displayName: 'builder',
      courier: 'delegated task review-abc from review',
    })
  })

  it('does not nudge a delivered parcel when --no-nudge', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder' } })
    dispatchOutboxes.mockResolvedValueOnce({
      senders: [
        {
          sender: 'review',
          results: [{ status: 'delivered', recipient: 'builder', parcelName: 'review-abc' }],
        },
      ],
      totalQueued: 1,
    } as never)
    vi.spyOn(logger, 'success').mockImplementation(() => {})
    const { default: cmd } = await import('./dispatch')
    await cmd.run!({ args: { agent: 'review', all: false, rebase: false, nudge: false } } as never)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })

  it('warns and does not nudge on unknown or failed recipients', async () => {
    dispatchOutboxes.mockResolvedValueOnce({
      senders: [
        {
          sender: 'review',
          results: [
            { status: 'unknown', recipient: 'typo' },
            { status: 'failed', recipient: 'builder', error: 'boom' },
          ],
        },
      ],
      totalQueued: 2,
    } as never)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { default: cmd } = await import('./dispatch')
    await cmd.run!({ args: { agent: 'review', all: false, rebase: false, nudge: true } } as never)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('logs the no-queued-parcels info when totalQueued is 0', async () => {
    dispatchOutboxes.mockResolvedValueOnce({ senders: [], totalQueued: 0 } as never)
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const { default: cmd } = await import('./dispatch')
    await cmd.run!({ args: { agent: 'review', all: false, rebase: false, nudge: true } } as never)
    expect(info.mock.calls.some((c) => String(c[0]).includes('no queued parcels'))).toBe(true)
  })
})
