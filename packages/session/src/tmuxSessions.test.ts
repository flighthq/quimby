import { describe, expect, it, vi } from 'vitest'

const execa = vi.hoisted(() => vi.fn())
vi.mock('execa', () => ({ execa }))

import { killQuimbyTmuxSession, listQuimbyTmuxSessions } from './tmuxSessions'

describe('killQuimbyTmuxSession', () => {
  it('reports true when tmux killed the session', async () => {
    execa.mockResolvedValueOnce({ stdout: '' })
    expect(await killQuimbyTmuxSession('qb-abc')).toBe(true)
    expect(execa).toHaveBeenCalledWith('tmux', ['-L', 'quimby', 'kill-session', '-t', 'qb-abc'])
  })

  it('reports false when there was no such session', async () => {
    execa.mockRejectedValueOnce(new Error("can't find session"))
    expect(await killQuimbyTmuxSession('qb-gone')).toBe(false)
  })
})

describe('listQuimbyTmuxSessions', () => {
  it('parses every session, converting tmux epoch seconds to milliseconds', async () => {
    execa.mockResolvedValueOnce({
      stdout: ['qb-a1b2c3d4|0|1|1700000000|1700000600', 'qb-dash-proj|2|3|1700000000|1700000900'].join('\n'), // prettier-ignore
    })

    expect(await listQuimbyTmuxSessions()).toEqual([
      {
        name: 'qb-a1b2c3d4',
        attached: false,
        windows: 1,
        createdAt: 1_700_000_000_000,
        activityAt: 1_700_000_600_000,
      },
      {
        name: 'qb-dash-proj',
        attached: true,
        windows: 3,
        createdAt: 1_700_000_000_000,
        activityAt: 1_700_000_900_000,
      },
    ])
  })

  it('is an empty pool when no tmux server is running', async () => {
    execa.mockRejectedValueOnce(new Error('no server running'))
    expect(await listQuimbyTmuxSessions()).toEqual([])
  })

  it('skips blank lines', async () => {
    execa.mockResolvedValueOnce({ stdout: '\nqb-a1|0|1|1|2\n\n' })
    expect((await listQuimbyTmuxSessions()).map((s) => s.name)).toEqual(['qb-a1'])
  })

  it('reads the fields from the right, so a separator in the name cannot corrupt the parse', async () => {
    execa.mockResolvedValueOnce({ stdout: 'odd|name|0|1|1700000000|1700000600' })
    expect(await listQuimbyTmuxSessions()).toEqual([
      {
        name: 'odd|name',
        attached: false,
        windows: 1,
        createdAt: 1_700_000_000_000,
        activityAt: 1_700_000_600_000,
      },
    ])
  })
})
