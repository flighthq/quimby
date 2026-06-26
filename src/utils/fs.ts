import { mkdir, readFile, writeFile, access, cp, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}

export async function writeText(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf-8')
}

export { cp, readdir, mkdir }
