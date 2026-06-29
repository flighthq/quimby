import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getSSHTransport, getTransport, sq } from './transport'

let dir: string

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-transport-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sq', () => {
  it('wraps a simple string in single quotes', () => {
    expect(sq('hello')).toBe("'hello'")
  })

  it('escapes embedded single quotes', () => {
    expect(sq("it's here")).toBe("'it'\"'\"'s here'")
  })

  it('handles empty string', () => {
    expect(sq('')).toBe("''")
  })

  it('handles strings with spaces', () => {
    expect(sq('hello world')).toBe("'hello world'")
  })
})

describe('getTransport', () => {
  it('returns LocalTransport when location is undefined', () => {
    const transport = getTransport(undefined)
    expect(transport).toBeDefined()
    expect(typeof transport.readFile).toBe('function')
    expect(typeof transport.writeFile).toBe('function')
    expect(typeof transport.fileExists).toBe('function')
    expect(typeof transport.ensureDir).toBe('function')
  })

  it('returns SSHTransport when location is SSH', () => {
    const transport = getTransport({ type: 'ssh', host: 'user@box' })
    expect(transport).toBeDefined()
    expect(typeof transport.readFile).toBe('function')
    expect(typeof transport.writeFile).toBe('function')
  })

  it('returns LocalTransport for local location type', () => {
    const transport = getTransport({ type: 'local' })
    expect(transport).toBeDefined()
  })
})

describe('getSSHTransport', () => {
  it('returns an SSHTransport for a given SSH location', () => {
    const transport = getSSHTransport({ type: 'ssh', host: 'user@box' })
    expect(transport).toBeDefined()
    expect(typeof transport.readFile).toBe('function')
    expect(typeof transport.exec).toBe('function')
  })
})

describe('LocalTransport', () => {
  it('writeFile creates a file with content', async () => {
    const transport = getTransport(undefined)
    const file = join(dir, 'test.txt')
    await transport.writeFile(file, 'hello local')
    const content = await readFile(file, 'utf-8')
    expect(content).toBe('hello local')
  })

  it('writeFile creates parent directories', async () => {
    const transport = getTransport(undefined)
    const file = join(dir, 'nested', 'deep', 'file.txt')
    await transport.writeFile(file, 'nested content')
    const content = await readFile(file, 'utf-8')
    expect(content).toBe('nested content')
  })

  it('readFile reads file content', async () => {
    const transport = getTransport(undefined)
    const file = join(dir, 'read.txt')
    await transport.writeFile(file, 'read me')
    const content = await transport.readFile(file)
    expect(content).toBe('read me')
  })

  it('fileExists returns true for existing file', async () => {
    const transport = getTransport(undefined)
    const file = join(dir, 'exists.txt')
    await transport.writeFile(file, 'content')
    expect(await transport.fileExists(file)).toBe(true)
  })

  it('fileExists returns false for non-existent file', async () => {
    const transport = getTransport(undefined)
    expect(await transport.fileExists(join(dir, 'nope.txt'))).toBe(false)
  })

  it('ensureDir creates a directory', async () => {
    const transport = getTransport(undefined)
    const newDir = join(dir, 'new-dir')
    await transport.ensureDir(newDir)
    expect(await transport.fileExists(newDir)).toBe(true)
  })
})
