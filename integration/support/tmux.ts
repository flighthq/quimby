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

/** Tear down a test tmux server, ignoring "no server" errors. */
export async function killTmuxTestServer(socket: string): Promise<void> {
  await execa('tmux', ['-L', socket, 'kill-server']).catch(() => {})
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
