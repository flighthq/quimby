import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createTempWorkspace,
  isTmuxAvailable,
  killTmuxTestServer,
  runQuimby,
  type RunResult,
  STUB_ENTRYPOINT,
  type TempWorkspace,
  testTmuxSocket,
  tmuxSessionCount,
} from './support'

// Suite B — the headless tmux lifecycle, driving the real CLI: start (detached) → list shows
// running → nudge reaches the live stub → stop → list shows stopped, plus start idempotency.
//
// Isolation: every command runs on a per-test `quimby-e2e-<uuid>` tmux socket via
// QUIMBY_TMUX_SOCKET (the seam in @quimbyhq/paths), and teardown kills only that server — a
// developer's live `-L quimby` sessions are never touched.

const tmuxAvailable = await isTmuxAvailable()

let ws: TempWorkspace
let dir: string
let socket: string
let marker: string
let markerDir: string

/** Run the CLI on this test's isolated tmux socket; `start` also needs the stub's marker path. */
async function run(args: string[]): Promise<RunResult> {
  return runQuimby(dir, args, { env: { QUIMBY_TMUX_SOCKET: socket, QUIMBY_STUB_MARKER: marker } })
}

/** Poll the stub's marker file until it contains `text` (nudge/send-keys delivery is async). */
async function waitForMarker(text: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await readFile(marker, 'utf-8').catch(() => '')
    if (last.includes(text)) return last
    await new Promise((r) => setTimeout(r, 100))
  }
  return last
}

beforeEach(async () => {
  ws = await createTempWorkspace()
  dir = ws.dir
  socket = testTmuxSocket()
  markerDir = await mkdtemp(join(tmpdir(), 'qb-marker-'))
  marker = join(markerDir, 'marker')
  await run(['add', 'worker', '-r', 'local', '--cmd', `sh ${STUB_ENTRYPOINT}`])
})

afterEach(async () => {
  await killTmuxTestServer(socket)
  await ws.cleanup()
  await rm(markerDir, { recursive: true, force: true })
})

describe.skipIf(!tmuxAvailable)('Suite B — tmux session lifecycle (real CLI)', () => {
  it('start → running → nudge delivers → stop → stopped', async () => {
    const started = await run(['start', 'worker'])
    expect(started.exitCode, started.output).toBe(0)
    // The detached session exists on the isolated socket, and list reports it running.
    expect(await tmuxSessionCount(socket)).toBe(1)
    expect((await run(['list'])).output).toContain('running')
    // The stub came up (it appends "ready" on launch).
    expect(await waitForMarker('ready')).toContain('ready')

    // A nudge is typed into the live session and reaches the stub's stdin.
    const nudged = await run(['nudge', 'worker', '-m', 'hello-from-nudge'])
    expect(nudged.exitCode, nudged.output).toBe(0)
    expect(await waitForMarker('hello-from-nudge')).toContain('hello-from-nudge')

    // Stop kills the session; list then reports stopped and no server remains.
    const stopped = await run(['stop', 'worker'])
    expect(stopped.exitCode, stopped.output).toBe(0)
    expect(await tmuxSessionCount(socket)).toBe(0)
    expect((await run(['list'])).output).toContain('stopped')
  })

  it('start is idempotent — starting a running agent is a no-op, not a second session', async () => {
    await run(['start', 'worker'])
    await run(['start', 'worker'])
    expect(await tmuxSessionCount(socket)).toBe(1)
  })
})
