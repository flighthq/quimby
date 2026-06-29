import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadState } from '@quimbyhq/workspace'
import { ensureWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  setAgentDefaults,
  setAgentGuard,
  setAgentLocation,
  setAgentSyncRef,
  setAgentTmux,
} from './config'
import { addAgent } from './lifecycle'

vi.mock('@quimbyhq/git', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    clone: vi.fn(async (_url: string, dest: string) => {
      await mkdir(dest, { recursive: true })
      await execa('git', ['init'], { cwd: dest })
      await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: dest })
      await execa('git', ['config', 'user.name', 'Test User'], { cwd: dest })
      await writeFile(join(dest, '.gitkeep'), '')
      await execa('git', ['add', '-A'], { cwd: dest })
      await execa('git', ['commit', '-m', 'initial'], { cwd: dest })
    }),
  }
})

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
  dir = join(tmpdir(), `quimby-config-${crypto.randomUUID()}`)
  await setupGitRepo(dir)
  await ensureWorkspace(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('setAgentDefaults', () => {
  it('updates runtime and entrypoint on the agent state', async () => {
    await addAgent(dir, 'alice')
    await setAgentDefaults(dir, 'alice', { runtime: 'sbx', entrypoint: 'codex' })
    const state = await loadState(dir)
    expect(state.agents.alice.defaults?.runtime).toBe('sbx')
    expect(state.agents.alice.defaults?.entrypoint).toBe('codex')
  })
})

describe('setAgentGuard', () => {
  it('sets and clears the agent guard command', async () => {
    await addAgent(dir, 'alice')
    await setAgentGuard(dir, 'alice', 'npm run ci')
    let state = await loadState(dir)
    expect(state.agents.alice.guard).toBe('npm run ci')

    await setAgentGuard(dir, 'alice', '')
    state = await loadState(dir)
    expect(state.agents.alice.guard).toBeUndefined()
  })
})

describe('setAgentLocation', () => {
  it('updates the location on the agent state', async () => {
    await addAgent(dir, 'alice')
    await setAgentLocation(dir, 'alice', { type: 'local' })
    const state = await loadState(dir)
    expect(state.agents.alice.location).toEqual({ type: 'local' })
  })
})

describe('setAgentSyncRef', () => {
  it('retargets the ref the agent syncs against', async () => {
    await addAgent(dir, 'alice')
    await setAgentSyncRef(dir, 'alice', 'release')
    const state = await loadState(dir)
    expect(state.agents.alice.syncRef).toBe('release')
  })

  it('throws QuimbyError when the agent does not exist', async () => {
    await expect(setAgentSyncRef(dir, 'ghost', 'main')).rejects.toThrow('not found')
  })
})

describe('setAgentTmux', () => {
  it('opts the agent into tmux and clears the flag', async () => {
    await addAgent(dir, 'alice')
    await setAgentTmux(dir, 'alice', true)
    let state = await loadState(dir)
    expect(state.agents.alice.tmux).toBe(true)

    await setAgentTmux(dir, 'alice', false)
    state = await loadState(dir)
    expect(state.agents.alice.tmux).toBeUndefined()
  })
})
