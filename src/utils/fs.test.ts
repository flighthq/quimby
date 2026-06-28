import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ensureDir, exists, readText, writeText } from './fs'

let dir: string

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-fs-${crypto.randomUUID()}`)
  await ensureDir(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ensureDir', () => {
  it('creates a directory', async () => {
    const target = join(dir, 'new-dir')
    await ensureDir(target)
    expect(await exists(target)).toBe(true)
  })

  it('creates nested directories', async () => {
    const target = join(dir, 'a', 'b', 'c')
    await ensureDir(target)
    expect(await exists(target)).toBe(true)
  })

  it('is idempotent — does not throw if directory already exists', async () => {
    const target = join(dir, 'existing')
    await ensureDir(target)
    await expect(ensureDir(target)).resolves.toBeUndefined()
    expect(await exists(target)).toBe(true)
  })
})

describe('exists', () => {
  it('returns true for an existing file', async () => {
    const file = join(dir, 'file.txt')
    await writeFile(file, 'hello')
    expect(await exists(file)).toBe(true)
  })

  it('returns true for an existing directory', async () => {
    expect(await exists(dir)).toBe(true)
  })

  it('returns false for a non-existent path', async () => {
    expect(await exists(join(dir, 'does-not-exist'))).toBe(false)
  })
})

describe('readText', () => {
  it('reads file content as string', async () => {
    const file = join(dir, 'test.txt')
    await writeFile(file, 'hello world')
    expect(await readText(file)).toBe('hello world')
  })

  it('reads multi-line content', async () => {
    const file = join(dir, 'multi.txt')
    const content = 'line 1\nline 2\nline 3'
    await writeFile(file, content)
    expect(await readText(file)).toBe(content)
  })
})

describe('writeText', () => {
  it('writes content to a file', async () => {
    const file = join(dir, 'out.txt')
    await writeText(file, 'written content')
    const content = await readText(file)
    expect(content).toBe('written content')
  })

  it('overwrites existing content', async () => {
    const file = join(dir, 'overwrite.txt')
    await writeText(file, 'original')
    await writeText(file, 'replaced')
    expect(await readText(file)).toBe('replaced')
  })
})
