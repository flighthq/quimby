import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadState, saveState } from './state'
import { ensureWorkspace } from './workspace'

let dir: string

async function setupGitRepo(repoDir: string) {
  await mkdir(repoDir, { recursive: true })
  await execa('git', ['init'], { cwd: repoDir })
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir })
  await writeFile(join(repoDir, 'README.md'), '# Test')
  await execa('git', ['add', '-A'], { cwd: repoDir })
  await execa('git', ['commit', '-m', 'initial'], { cwd: repoDir })
}

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-state-${crypto.randomUUID()}`)
  await setupGitRepo(dir)
  await ensureWorkspace(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadState', () => {
  it('reads state.yaml and returns a QuimbyState', async () => {
    const state = await loadState(dir)
    expect(state.id).toBeDefined()
    expect(state.agents).toBeDefined()
    expect(state.sourceRepo).toBeDefined()
  })
})

describe('saveState', () => {
  it('writes state.yaml with the correct content', async () => {
    const state = await loadState(dir)
    state.agents['test-agent'] = {
      id: 'agent-uuid',
      name: 'test-agent',
      seedCommit: 'abc123',
      createdAt: new Date().toISOString(),
    }
    await saveState(dir, state)

    const loaded = await loadState(dir)
    expect(loaded.agents['test-agent']).toBeDefined()
    expect(loaded.agents['test-agent'].id).toBe('agent-uuid')
  })
})
