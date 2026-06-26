import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { startWatcher } from '../../src/core/watcher.js'
import type { WorkspaceConfig } from '../../src/types/config.js'

let tmp: string
let workspacePath: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-watcher-test-'))
  workspacePath = join(tmp, 'workspace')
  await mkdir(join(workspacePath, 'sandboxes', 'frontend', '.sandbox', 'bundles'), { recursive: true })
  await mkdir(join(workspacePath, 'sandboxes', 'backend', '.sandbox', 'inbox'), { recursive: true })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const config: WorkspaceConfig = {
  source: { ref: 'main' },
  sandboxes: {
    frontend: {
      role: 'Frontend',
      runtime: { type: 'docker-sandbox', launch: () => [] },
    },
    backend: {
      role: 'Backend',
      runtime: { type: 'docker-sandbox', launch: () => [] },
      receives: ['frontend'],
    },
  },
}

describe('startWatcher', () => {
  it('returns a closable watcher', async () => {
    const watcher = startWatcher({ workspacePath, config })
    expect(watcher.close).toBeDefined()
    await watcher.close()
  })

  it('detects new bundles via meta.yaml creation', async () => {
    let detectedBundle: string | undefined

    const watcher = startWatcher({
      workspacePath,
      config,
      callbacks: {
        onBundleCreated(sandbox, bundleId) {
          detectedBundle = `${sandbox}/${bundleId}`
        },
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    const bundleDir = join(workspacePath, 'sandboxes', 'frontend', '.sandbox', 'bundles', '001-types')
    await mkdir(bundleDir, { recursive: true })
    await writeFile(join(bundleDir, 'squashed.diff'), 'diff')
    await writeFile(join(bundleDir, 'meta.yaml'), 'id: 001-types')

    await new Promise((r) => setTimeout(r, 500))
    await watcher.close()

    expect(detectedBundle).toBe('frontend/001-types')
  })

  it('detects status changes', async () => {
    let statusChanged: string | undefined
    await writeFile(
      join(workspacePath, 'sandboxes', 'frontend', '.sandbox', 'status.md'),
      'idle',
    )

    const watcher = startWatcher({
      workspacePath,
      config,
      callbacks: {
        onStatusChanged(sandbox) {
          statusChanged = sandbox
        },
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    await writeFile(
      join(workspacePath, 'sandboxes', 'frontend', '.sandbox', 'status.md'),
      'working on assignment',
    )

    await new Promise((r) => setTimeout(r, 500))
    await watcher.close()

    expect(statusChanged).toBe('frontend')
  })
})
