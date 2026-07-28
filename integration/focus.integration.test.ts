import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isTmuxAvailable, killTmuxTestServer } from './support'

// `quimbyTmuxSocket` is read from the environment ONCE, at import time (a module-level const in
// @quimbyhq/paths). The other suites sidestep that by passing the env to a subprocess; this one
// calls the probe in-process, so the socket must be set before the import — hence `vi.hoisted`,
// which runs ahead of the import graph. One socket for the file; teardown kills the server between
// tests, so each rebuilds its sessions from scratch.
const socket = vi.hoisted(() => {
  const name = `quimby-e2e-${crypto.randomUUID()}`
  process.env.QUIMBY_TMUX_SOCKET = name
  return name
})

const { getFocusedTmuxWindows } = await import('@quimbyhq/session')

// Suite D — §7's focus probe against a REAL nested tmux dashboard. The unit tests drive
// `resolveFocusedWindows` with synthetic rows; this pins the half they cannot: that the tmux
// format strings parse, and that a panel dashboard's client-per-pane really does resolve to the
// single window the human is in. Without it, a dashboard holds every agent's nudge forever.
//
// Isolation: a per-test `quimby-e2e-<uuid>` socket via QUIMBY_TMUX_SOCKET (the @quimbyhq/paths
// seam getFocusedTmuxWindows reads), killed in teardown — a developer's live `-L quimby` is safe.

const tmuxAvailable = await isTmuxAvailable()

async function tmux(...args: string[]): Promise<void> {
  await execa('tmux', ['-L', socket, ...args])
}

async function attachedCount(session: string): Promise<string> {
  const { stdout } = await execa('tmux', [
    '-L',
    socket,
    'display-message',
    '-p',
    '-t',
    session,
    '#{session_attached}',
  ])
  return stdout.trim()
}

/**
 * The three-layer nesting a panel dashboard builds: two agent sessions, each linked into its own
 * ephemeral view session, both views attached as panes of one wrapper, with a real client on the
 * wrapper. Mirrors `runPanelDashboard` closely enough to exercise the same focus chain.
 */
async function buildPanelDashboard(): Promise<void> {
  await tmux('new-session', '-d', '-s', 'qb-aaa', '-n', 'review', 'sleep 600')
  await tmux('new-session', '-d', '-s', 'qb-bbb', '-n', 'builder', 'sleep 600')
  for (const [view, src, name] of [
    ['qbv-0', 'qb-aaa', 'review'],
    ['qbv-1', 'qb-bbb', 'builder'],
  ]) {
    await tmux('new-session', '-d', '-s', view, '-n', 'ph', 'sleep 600')
    await tmux('link-window', '-s', `${src}:${name}`, '-t', `${view}:`)
    await tmux('kill-window', '-t', `${view}:ph`)
  }
  await tmux('new-session', '-d', '-s', 'qb-dash', `TMUX= tmux -L ${socket} attach -t qbv-0`)
  await tmux('split-window', '-t', 'qb-dash', `TMUX= tmux -L ${socket} attach -t qbv-1`)
  await tmux('new-session', '-d', '-s', 'holder', `TMUX= tmux -L ${socket} attach -t qb-dash`)
  // The nested attaches are subprocesses; give them a beat to register as clients.
  await new Promise((r) => setTimeout(r, 2000))
}

afterEach(async () => {
  await killTmuxTestServer(socket)
})

describe.skipIf(!tmuxAvailable)('Suite D — §7 focus detection (real nested tmux)', () => {
  it('resolves to the one focused pane, and follows the selection across panes', async () => {
    await buildPanelDashboard()

    await tmux('select-pane', '-t', 'qb-dash.0')
    await new Promise((r) => setTimeout(r, 500))
    const left = await getFocusedTmuxWindows()
    expect(left.names.has('review')).toBe(true)
    expect(left.names.has('builder')).toBe(false)

    await tmux('select-pane', '-t', 'qb-dash.1')
    await new Promise((r) => setTimeout(r, 500))
    const right = await getFocusedTmuxWindows()
    expect(right.names.has('builder')).toBe(true)
    expect(right.names.has('review')).toBe(false)
  })

  it('a link-window dashboard leaves the agent session unattached (why local agents never held)', async () => {
    await buildPanelDashboard()
    expect(await attachedCount('qb-aaa')).toBe('0')
    expect(await attachedCount('qbv-0')).toBe('1')
  })

  it('a direct attach IS the focus, so a single `quimby run <agent>` still holds', async () => {
    await tmux('new-session', '-d', '-s', 'qb-ccc', '-n', 'solo', 'sleep 600')
    await tmux('new-session', '-d', '-s', 'holder', `TMUX= tmux -L ${socket} attach -t qb-ccc`)
    await new Promise((r) => setTimeout(r, 2000))

    expect(await attachedCount('qb-ccc')).toBe('1')
    expect((await getFocusedTmuxWindows()).names.has('solo')).toBe(true)
  })
})
