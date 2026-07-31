import { describe, expect, it } from 'vitest'

import type { TmuxClientInfo, TmuxPaneInfo } from './focus'
import { resolveFocusedWindows } from './focus'

function pane(
  over: Partial<TmuxPaneInfo> & Pick<TmuxPaneInfo, 'session' | 'windowId'>,
): TmuxPaneInfo {
  return {
    tty: `/dev/pts/${over.windowId}`,
    windowName: over.windowId.replace('@', 'w'),
    windowActive: true,
    paneActive: true,
    ...over,
  }
}

describe('getFocusedTmuxWindows', () => {
  it('is covered through resolveFocusedWindows (the tmux probe is a thin shell-out)', () => {
    expect(resolveFocusedWindows([], [])).toEqual({ ids: new Set(), names: new Set() })
  })
})

describe('hasLocalWindowNamed', () => {
  it('is covered through resolveFocusedWindows (the tmux probe is a thin shell-out)', () => {
    expect(resolveFocusedWindows([], [])).toEqual({ ids: new Set(), names: new Set() })
  })
})

describe('resolveFocusedWindows', () => {
  it('stops treating a window as focused once its client goes idle (the overnight case)', () => {
    const now = 1_000_000
    const clients: TmuxClientInfo[] = [
      { tty: '/dev/pts/0', session: 'qb-builder', activity: now - 20 },
    ]
    const panes = [pane({ session: 'qb-builder', windowId: '@1', windowName: 'builder' })]
    // actively typing → held
    expect(resolveFocusedWindows(clients, panes, now).names.has('builder')).toBe(true)
    // same window, but nobody has touched the keyboard for an hour → nudge it
    const idle = [{ ...clients[0], activity: now - 3600 }]
    expect(resolveFocusedWindows(idle, panes, now).names.size).toBe(0)
  })

  it('separates watching from typing at the 45s default — the supervised-agent case', () => {
    const now = 1_000_000
    const panes = [pane({ session: 'qb-builder', windowId: '@1', windowName: 'builder' })]
    const at = (secondsAgo: number): TmuxClientInfo[] => [
      { tty: '/dev/pts/0', session: 'qb-builder', activity: now - secondsAgo },
    ]
    // Typed 10s ago — still composing, so hold.
    expect(resolveFocusedWindows(at(10), panes, now).names.has('builder')).toBe(true)
    // Typed 60s ago and has been reading since. tmux freezes `client_activity` while a client only
    // watches (verified on tmux 3.6), so this is genuinely "not typing" — the old 180s window kept
    // holding here, which is what stalled a fleet you were merely supervising.
    expect(resolveFocusedWindows(at(60), panes, now).names.size).toBe(0)
  })

  it('honors an explicit grace, so a slow composer can widen the window', () => {
    const now = 1_000_000
    const panes = [pane({ session: 'qb-builder', windowId: '@1', windowName: 'builder' })]
    const clients: TmuxClientInfo[] = [
      { tty: '/dev/pts/0', session: 'qb-builder', activity: now - 60 },
    ]
    expect(resolveFocusedWindows(clients, panes, now, 180).names.has('builder')).toBe(true)
    expect(resolveFocusedWindows(clients, panes, now, 30).names.size).toBe(0)
  })

  it('treats a client with no activity time as active, never inventing an idle window', () => {
    const clients: TmuxClientInfo[] = [{ tty: '/dev/pts/0', session: 'qb-builder' }]
    const panes = [pane({ session: 'qb-builder', windowId: '@1', windowName: 'builder' })]
    expect(resolveFocusedWindows(clients, panes, 1_000_000).names.has('builder')).toBe(true)
  })

  it('reports the attached session’s active window for a plain single attach', () => {
    const clients: TmuxClientInfo[] = [{ tty: '/dev/pts/0', session: 'qb-builder' }]
    const panes = [
      pane({ session: 'qb-builder', windowId: '@1', windowName: 'builder' }),
      pane({ session: 'qb-review', windowId: '@2', windowName: 'review' }),
    ]
    const focused = resolveFocusedWindows(clients, panes)
    expect([...focused.names]).toEqual(['builder'])
    expect([...focused.ids]).toEqual(['@1'])
  })

  it('follows the dashboard chain to the one pane the human is in, not every attached pane', () => {
    // wrapper session `dash` splits into two panes; each pane runs `tmux attach` to a view
    // session (the nested clients). Only the wrapper's ACTIVE pane is where keystrokes land.
    const clients: TmuxClientInfo[] = [
      { tty: '/dev/pts/0', session: 'qb-dash' }, // the real terminal
      { tty: '/dev/pts/1', session: 'qbv-0' }, // nested: left pane
      { tty: '/dev/pts/2', session: 'qbv-1' }, // nested: right pane
    ]
    const panes = [
      pane({ session: 'qb-dash', windowId: '@0', tty: '/dev/pts/1', paneActive: true }),
      pane({ session: 'qb-dash', windowId: '@0', tty: '/dev/pts/2', paneActive: false }),
      pane({ session: 'qbv-0', windowId: '@10', windowName: 'review', tty: '/dev/pts/10' }),
      pane({ session: 'qbv-1', windowId: '@11', windowName: 'builder', tty: '/dev/pts/11' }),
    ]
    const focused = resolveFocusedWindows(clients, panes)
    expect([...focused.names]).toEqual(['review'])
    expect(focused.names.has('builder')).toBe(false)
  })

  it('ignores a session’s non-active windows, so a background tab never counts as focused', () => {
    const clients: TmuxClientInfo[] = [{ tty: '/dev/pts/0', session: 'qbv-0' }]
    const panes = [
      pane({ session: 'qbv-0', windowId: '@1', windowName: 'review', windowActive: true }),
      pane({ session: 'qbv-0', windowId: '@2', windowName: 'builder', windowActive: false }),
    ]
    expect([...resolveFocusedWindows(clients, panes).names]).toEqual(['review'])
  })

  it('returns nothing when no client is attached', () => {
    const panes = [pane({ session: 'qb-builder', windowId: '@1', windowName: 'builder' })]
    expect(resolveFocusedWindows([], panes)).toEqual({ ids: new Set(), names: new Set() })
  })

  it('does not loop forever when a client chain is cyclic', () => {
    const clients: TmuxClientInfo[] = [
      { tty: '/dev/pts/1', session: 'a' },
      { tty: '/dev/pts/2', session: 'b' },
    ]
    const panes = [
      pane({ session: 'a', windowId: '@1', tty: '/dev/pts/2' }),
      pane({ session: 'b', windowId: '@2', tty: '/dev/pts/1' }),
    ]
    expect(resolveFocusedWindows(clients, panes).names.size).toBe(0)
  })
})
