import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ensureDir, exists, readText, writeText } from '../../src/utils/fs.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-test-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('ensureDir', () => {
  it('creates a nested directory', async () => {
    const dir = join(tmp, 'a', 'b', 'c')
    await ensureDir(dir)
    expect(await exists(dir)).toBe(true)
  })

  it('is idempotent', async () => {
    const dir = join(tmp, 'x')
    await ensureDir(dir)
    await ensureDir(dir)
    expect(await exists(dir)).toBe(true)
  })
})

describe('exists', () => {
  it('returns true for existing files', async () => {
    const file = join(tmp, 'file.txt')
    await writeText(file, 'hello')
    expect(await exists(file)).toBe(true)
  })

  it('returns false for non-existing paths', async () => {
    expect(await exists(join(tmp, 'nope'))).toBe(false)
  })
})

describe('readText', () => {
  it('reads a file as UTF-8 string', async () => {
    const file = join(tmp, 'data.txt')
    await writeText(file, 'test content')
    expect(await readText(file)).toBe('test content')
  })
})

describe('writeText', () => {
  it('writes content to a file', async () => {
    const file = join(tmp, 'output.txt')
    await writeText(file, 'written')
    expect(await readText(file)).toBe('written')
  })

  it('overwrites existing content', async () => {
    const file = join(tmp, 'over.txt')
    await writeText(file, 'first')
    await writeText(file, 'second')
    expect(await readText(file)).toBe('second')
  })
})
