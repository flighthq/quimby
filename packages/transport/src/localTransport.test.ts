import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocalTransport } from './localTransport'

let dir: string

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-local-transport-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LocalTransport', () => {
  it('ensureDir creates a directory', async () => {
    const transport = new LocalTransport()
    const newDir = join(dir, 'new-dir')
    await transport.ensureDir(newDir)
    expect(await transport.fileExists(newDir)).toBe(true)
  })

  it('fileExists returns false for non-existent file', async () => {
    const transport = new LocalTransport()
    expect(await transport.fileExists(join(dir, 'nope.txt'))).toBe(false)
  })

  it('fileExists returns true for existing file', async () => {
    const transport = new LocalTransport()
    const file = join(dir, 'exists.txt')
    await transport.writeFile(file, 'content')
    expect(await transport.fileExists(file)).toBe(true)
  })

  it('readFile reads file content', async () => {
    const transport = new LocalTransport()
    const file = join(dir, 'read.txt')
    await transport.writeFile(file, 'read me')
    const content = await transport.readFile(file)
    expect(content).toBe('read me')
  })

  it('writeFile creates a file with content', async () => {
    const transport = new LocalTransport()
    const file = join(dir, 'test.txt')
    await transport.writeFile(file, 'hello local')
    const content = await readFile(file, 'utf-8')
    expect(content).toBe('hello local')
  })

  it('writeFile creates parent directories', async () => {
    const transport = new LocalTransport()
    const file = join(dir, 'nested', 'deep', 'file.txt')
    await transport.writeFile(file, 'nested content')
    const content = await readFile(file, 'utf-8')
    expect(content).toBe('nested content')
  })
})
