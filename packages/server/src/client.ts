import { unlink } from 'node:fs/promises'

import { getQuimbyDir } from '@quimbyhq/paths'
import { exists, readText } from '@quimbyhq/utils'
import { join } from 'pathe'

import type { ServerInfo } from './server'

export async function getServerInfo(repoRoot: string): Promise<ServerInfo | null> {
  const infoPath = join(getQuimbyDir(repoRoot), 'server.json')
  if (!(await exists(infoPath))) return null

  try {
    const info = JSON.parse(await readText(infoPath)) as ServerInfo
    process.kill(info.pid, 0)
    return info
  } catch {
    return null
  }
}

export function isServerRunning(repoRoot: string): Promise<boolean> {
  return getServerInfo(repoRoot).then((info) => info !== null)
}

export async function serverGet(repoRoot: string, path: string): Promise<unknown> {
  const info = await getServerInfo(repoRoot)
  if (!info) return null

  const res = await fetch(`http://127.0.0.1:${info.port}${path}`)
  if (!res.ok) return null
  return res.json()
}

export async function serverPost(repoRoot: string, path: string, body: unknown): Promise<boolean> {
  const info = await getServerInfo(repoRoot)
  if (!info) return false

  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.ok
}

export async function serverDelete(repoRoot: string, path: string): Promise<boolean> {
  const info = await getServerInfo(repoRoot)
  if (!info) return false

  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: 'DELETE',
  })
  return res.ok
}

/**
 * Stop a running quimby server: read its `server.json`, signal the pid to shut down (the
 * server's SIGTERM handler runs its own graceful cleanup), and remove the pidfile so a stale
 * entry never lingers. Returns the `ServerInfo` that was stopped, or `null` when no live
 * server was found — in which case any stale pidfile is still cleared.
 */
export async function stopServer(repoRoot: string): Promise<ServerInfo | null> {
  const info = await getServerInfo(repoRoot)
  if (!info) {
    await removeServerJson(repoRoot)
    return null
  }
  try {
    process.kill(info.pid, 'SIGTERM')
  } catch {
    // The process vanished between the liveness probe and the signal — fall through to cleanup.
  }
  await removeServerJson(repoRoot)
  return info
}

async function removeServerJson(repoRoot: string): Promise<void> {
  try {
    await unlink(join(getQuimbyDir(repoRoot), 'server.json'))
  } catch {
    // Already gone — nothing to clean up.
  }
}
