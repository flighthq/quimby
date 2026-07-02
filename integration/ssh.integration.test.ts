import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { remoteAgentDir, remoteAgentRepoDir } from '@quimbyhq/paths'
import type { SSHLocation } from '@quimbyhq/types'
import { exists } from '@quimbyhq/utils'
import { loadState } from '@quimbyhq/workspace'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agentState,
  createTempWorkspace,
  git,
  isSshLoopbackAvailable,
  killTmuxTestServer,
  runQuimby,
  type RunResult,
  sshExec,
  sshLoopbackHost,
  sshPathExists,
  STUB_ENTRYPOINT,
  type TempWorkspace,
  testTmuxSocket,
} from './support'

// Suite C — an SSH agent over loopback, exercising the real remote path (rsync + remote clone +
// seed tag + transport round-trip) that unit tests can only mock. It self-skips when passwordless
// `ssh localhost` is unavailable (most dev boxes); CI provisions sshd so it runs there.
//
// Isolation: the CLI drives its (remote, but loopback = same host) tmux on a per-test
// QUIMBY_TMUX_SOCKET, and each remote workspace is namespaced by a fresh project UUID, so nothing
// collides with a real quimby remote workspace.

const sshAvailable = await isSshLoopbackAvailable()

let ws: TempWorkspace
let dir: string
let socket: string
let host: string
let markerDir: string
let marker: string

async function run(args: string[]): Promise<RunResult> {
  return runQuimby(dir, args, { env: { QUIMBY_TMUX_SOCKET: socket, QUIMBY_STUB_MARKER: marker } })
}

beforeEach(async () => {
  ws = await createTempWorkspace()
  dir = ws.dir
  socket = testTmuxSocket()
  host = sshLoopbackHost()
  markerDir = await mkdtemp(join(tmpdir(), 'qb-marker-'))
  marker = join(markerDir, 'marker')
})

afterEach(async () => {
  // Best-effort remote + local teardown (each may already be gone).
  await run(['remove', 'worker', '--force']).catch(() => {})
  await killTmuxTestServer(socket)
  await ws.cleanup()
  await rm(markerDir, { recursive: true, force: true })
})

describe.skipIf(!sshAvailable)('Suite C — SSH agent over loopback (real transport)', () => {
  it('initializes the remote layout and round-trips work back over transport', async () => {
    const added = await run(['add', 'worker', '--host', host, '-c', `sh ${STUB_ENTRYPOINT}`])
    expect(added.exitCode, added.output).toBe(0)
    const state = await loadState(dir)
    const agent = await agentState(dir, 'worker')
    const base = (agent.location as SSHLocation).base
    const rRepo = remoteAgentRepoDir(state.id, agent.id, base)
    // No local clone for an SSH agent — it's initialized lazily on first launch.
    expect(await exists(join(dir, '.quimby', 'agents', agent.id, 'repo'))).toBe(false)

    // `start` performs the real remote init: rsync → clone → tag quimby/seed → scaffold.
    const started = await run(['start', 'worker'])
    expect(started.exitCode, started.output).toBe(0)
    expect(await sshPathExists(host, `${rRepo}/.git`)).toBe(true)
    expect(await sshExec(host, `git -C ${rRepo} tag -l quimby/seed`)).toBe('quimby/seed')
    // Stop the remote session; the repo persists on disk.
    await run(['stop', 'worker'])

    // Play the remote agent: commit work directly in the remote clone.
    await sshExec(
      host,
      `cd ${rRepo} && echo 'remote feature' > feature.txt && git add -A && ` +
        `git commit -m 'remote work'`,
    )

    // `diff` pulls the remote working tree back over transport.
    expect((await run(['diff', 'worker'])).output).toContain('feature.txt')

    // `merge` lands the remote work in the host repo (commit .gitignore first for a clean tree).
    await git(dir, 'add', '.gitignore')
    await git(dir, 'commit', '-m', 'ignore .quimby')
    const merged = await run(['merge', 'worker', '-m', 'land remote work'])
    expect(merged.exitCode, merged.output).toBe(0)
    expect(await exists(join(dir, 'feature.txt'))).toBe(true)

    // `remove` cleans the remote agent directory.
    const removed = await run(['remove', 'worker'])
    expect(removed.exitCode, removed.output).toBe(0)
    expect(await sshPathExists(host, remoteAgentDir(state.id, agent.id, base))).toBe(false)
  })
})
