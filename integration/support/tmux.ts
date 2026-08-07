import { fileURLToPath } from 'node:url'

import { execa } from 'execa'

/** The stub agent entrypoint (stays alive, appends stdin to `$QUIMBY_STUB_MARKER`). */
export const STUB_ENTRYPOINT = fileURLToPath(new URL('./stub-agent.sh', import.meta.url))

/** Whether tmux is on PATH — a required dep for Suite B, but probed so a bare box skips cleanly. */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    await execa('tmux', ['-V'])
    return true
  } catch {
    return false
  }
}

/**
 * A unique tmux socket name for a Suite B run, so the harness never touches a developer's live
 * `-L quimby` server.
 *
 * NOTE (seam pending): the CLI currently hardcodes `quimbyTmuxSocket = 'quimby'`
 * (`@quimbyhq/paths`), so `start`/`nudge`/`stop`/`list` cannot yet be pointed at this socket.
 * Suite B is therefore blocked on a source seam (proposed to `review`: read the socket from
 * `QUIMBY_TMUX_SOCKET ?? 'quimby'`). This helper + {@link killTmuxTestServer} are the harness
 * side of that plan, ready to use once the seam lands.
 */
export function testTmuxSocket(): string {
  return `quimby-e2e-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Tear down a test tmux server, ignoring "no server" errors, and wait until it is actually gone.
 *
 * The wait is the point. `kill-server` returns as soon as the server ACCEPTS the request, not when
 * it has exited — the server still has to tear down its sessions, reap their child processes, and
 * unlink the socket. A `new-session` landing in that window connects to a socket whose server is
 * mid-exit and dies with `server exited unexpectedly`, which is exactly how Suite D flaked in CI:
 * a shared-socket suite kills the server in `afterEach`, so the very first tmux call of the NEXT
 * test is the one that lands in the window. It passes locally and fails on a loaded runner because
 * the window scales with how contended the machine is — the teardown of a nested dashboard (five
 * sessions plus three attached client subprocesses) is not instant.
 */
export async function killTmuxTestServer(socket: string): Promise<void> {
  await execa('tmux', ['-L', socket, 'kill-server']).catch(() => {})
  for (let attempt = 0; attempt < KILL_POLL_ATTEMPTS; attempt++) {
    if (await isTmuxServerDown(socket)) return
    await new Promise((resolve) => setTimeout(resolve, KILL_POLL_INTERVAL_MS))
  }
}

/** The `#{session_attached}`-style probe: how many sessions exist on a socket (0 when server is down). */
export async function tmuxSessionCount(socket: string): Promise<number> {
  try {
    const { stdout } = await execa('tmux', ['-L', socket, 'list-sessions'])
    return stdout.trim() === '' ? 0 : stdout.trim().split('\n').length
  } catch {
    return 0
  }
}

// The probe MUST NOT start a server. `list-sessions` is the one that doesn't: on a dead socket it
// exits non-zero with "no server running" rather than spawning one, so a non-zero exit means the
// socket is free and the next `new-session` will build a fresh server with no dying one to race.
//
// `start-server` was tried here first and is strictly WORSE THAN NO WAIT AT ALL: it starts a
// server, that server owns no sessions so it immediately exits, and the poll therefore returns
// exactly when a brand-new server is tearing itself down — recreating the window it was meant to
// close. Measured under CPU saturation over 30 rounds: no wait 1 failure, start-server 6, this
// probe 0. It is a good reminder that a probe which mutates what it observes is not a probe.
async function isTmuxServerDown(socket: string): Promise<boolean> {
  try {
    await execa('tmux', ['-L', socket, 'list-sessions'])
    return false
  } catch {
    return true
  }
}

const KILL_POLL_ATTEMPTS = 100
const KILL_POLL_INTERVAL_MS = 50
