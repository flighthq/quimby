import { join } from 'pathe'

import type { ServerInfo } from './server'
import { exists, readText } from './utils/fs'
import { getQuimbyDir } from './utils/paths'

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
