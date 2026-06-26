import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { LocalTransport } from '../../src/core/transport/local.js'
import { RemoteTransport } from '../../src/core/transport/remote.js'
import { createTransport } from '../../src/core/transport/index.js'
import type { SandboxState } from '../../src/types/workspace.js'

let tmp: string
let sandboxDir: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-transport-test-'))
  sandboxDir = join(tmp, 'sandbox')
  await mkdir(sandboxDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('LocalTransport', () => {
  let transport: LocalTransport

  beforeEach(() => {
    transport = new LocalTransport(sandboxDir)
  })

  describe('pushFile', () => {
    it('writes a file at a relative path', async () => {
      await transport.pushFile('test.txt', 'hello')
      const content = await readFile(join(sandboxDir, 'test.txt'), 'utf-8')
      expect(content).toBe('hello')
    })

    it('creates parent directories', async () => {
      await transport.pushFile('a/b/deep.txt', 'deep')
      const content = await readFile(join(sandboxDir, 'a', 'b', 'deep.txt'), 'utf-8')
      expect(content).toBe('deep')
    })
  })

  describe('pullFile', () => {
    it('reads a file', async () => {
      await writeFile(join(sandboxDir, 'read.txt'), 'content')
      const result = await transport.pullFile('read.txt')
      expect(result).toBe('content')
    })
  })

  describe('exists', () => {
    it('returns true for existing paths', async () => {
      await writeFile(join(sandboxDir, 'exists.txt'), 'yes')
      expect(await transport.exists('exists.txt')).toBe(true)
    })

    it('returns false for missing paths', async () => {
      expect(await transport.exists('nope.txt')).toBe(false)
    })
  })

  describe('listDir', () => {
    it('lists directory contents', async () => {
      await mkdir(join(sandboxDir, 'dir'))
      await writeFile(join(sandboxDir, 'dir', 'a.txt'), 'a')
      await writeFile(join(sandboxDir, 'dir', 'b.txt'), 'b')
      const entries = await transport.listDir('dir')
      expect(entries.sort()).toEqual(['a.txt', 'b.txt'])
    })

    it('returns empty array for non-existent dir', async () => {
      const entries = await transport.listDir('missing')
      expect(entries).toEqual([])
    })
  })

  describe('ensureDir', () => {
    it('creates a directory', async () => {
      await transport.ensureDir('new/nested')
      expect(await transport.exists('new/nested')).toBe(true)
    })
  })

  describe('pushDir', () => {
    it('copies a local directory to the sandbox', async () => {
      const srcDir = join(tmp, 'source')
      await mkdir(srcDir)
      await writeFile(join(srcDir, 'file.txt'), 'copied')
      await transport.pushDir(srcDir, 'dest')
      const content = await readFile(join(sandboxDir, 'dest', 'file.txt'), 'utf-8')
      expect(content).toBe('copied')
    })
  })

  describe('pullDir', () => {
    it('copies a sandbox directory to a local path', async () => {
      await mkdir(join(sandboxDir, 'src'))
      await writeFile(join(sandboxDir, 'src', 'pulled.txt'), 'data')
      const destDir = join(tmp, 'pulled')
      await transport.pullDir('src', destDir)
      const content = await readFile(join(destDir, 'pulled.txt'), 'utf-8')
      expect(content).toBe('data')
    })
  })

  describe('exec', () => {
    it('executes a command in the sandbox directory', async () => {
      const result = await transport.exec(['echo', 'hello'])
      expect(result.stdout.trim()).toBe('hello')
      expect(result.exitCode).toBe(0)
    })

    it('respects cwd option', async () => {
      await mkdir(join(sandboxDir, 'sub'))
      const result = await transport.exec(['pwd'], { cwd: 'sub' })
      expect(result.stdout.trim()).toBe(join(sandboxDir, 'sub'))
    })

    it('returns non-zero exit code on failure', async () => {
      const result = await transport.exec(['false'])
      expect(result.exitCode).not.toBe(0)
    })
  })

  describe('watch', () => {
    it('returns a closable watcher', async () => {
      const watcher = transport.watch(() => {})
      expect(watcher.close).toBeDefined()
      await watcher.close()
    })
  })
})

describe('RemoteTransport', () => {
  describe('constructor', () => {
    it('stores connection details', () => {
      const transport = new RemoteTransport('/remote/path', 'host.local', 'user', 2222)
      expect(transport.sandboxPath).toBe('/remote/path')
    })
  })
})

describe('createTransport', () => {
  const baseSandboxState: SandboxState = {
    name: 'test',
    status: 'idle',
    runtimeType: 'docker-sandbox',
    seedCommit: 'abc123',
    createdAt: '2024-01-01T00:00:00Z',
  }

  it('creates a LocalTransport for local sandboxes', () => {
    const transport = createTransport('/ws', baseSandboxState)
    expect(transport).toBeInstanceOf(LocalTransport)
  })

  it('creates a RemoteTransport for remote sandboxes', () => {
    const transport = createTransport('/ws', {
      ...baseSandboxState,
      runtimeType: 'remote',
      host: 'gpu.local',
      user: 'dev',
      remotePath: '/remote/sandboxes/test',
    })
    expect(transport).toBeInstanceOf(RemoteTransport)
  })
})
