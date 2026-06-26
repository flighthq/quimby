import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { sendBundle, sendBundleViaTransport } from '../../src/core/inbox.js'
import { LocalTransport } from '../../src/core/transport/local.js'
import { exists, readText } from '../../src/utils/fs.js'

let tmp: string
let workspacePath: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-inbox-test-'))
  workspacePath = join(tmp, 'workspace')

  const fromBundle = join(workspacePath, 'sandboxes', 'frontend', '.sandbox', 'bundles', '001-types')
  await mkdir(fromBundle, { recursive: true })
  await writeFile(join(fromBundle, 'meta.yaml'), 'id: 001-types')
  await writeFile(join(fromBundle, 'squashed.diff'), 'diff content')

  await mkdir(join(workspacePath, 'sandboxes', 'backend', '.sandbox', 'inbox'), { recursive: true })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('sendBundle', () => {
  it('copies bundle to destination inbox', async () => {
    await sendBundle({
      workspacePath,
      fromSandbox: 'frontend',
      toSandbox: 'backend',
      bundleId: '001-types',
    })

    const destMeta = join(
      workspacePath, 'sandboxes', 'backend', '.sandbox', 'inbox', 'from-frontend', '001-types', 'meta.yaml',
    )
    expect(await exists(destMeta)).toBe(true)
  })

  it('throws when source bundle does not exist', async () => {
    await expect(
      sendBundle({
        workspacePath,
        fromSandbox: 'frontend',
        toSandbox: 'backend',
        bundleId: 'nonexistent',
      }),
    ).rejects.toThrow('not found')
  })
})

describe('sendBundleViaTransport', () => {
  it('copies bundle between transports', async () => {
    const fromPath = join(workspacePath, 'sandboxes', 'frontend')
    const toPath = join(workspacePath, 'sandboxes', 'backend')

    const fromTransport = new LocalTransport(fromPath)
    const toTransport = new LocalTransport(toPath)
    const tempDir = join(tmp, 'temp')
    await mkdir(tempDir, { recursive: true })

    await sendBundleViaTransport({
      fromTransport,
      toTransport,
      fromSandbox: 'frontend',
      bundleId: '001-types',
      tempDir,
    })

    expect(
      await toTransport.exists('.sandbox/inbox/from-frontend/001-types/meta.yaml'),
    ).toBe(true)
  })
})
