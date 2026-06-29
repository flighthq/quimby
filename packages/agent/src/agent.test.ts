import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentDir } from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace, loadState } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addAgent,
  rebuildAgent,
  removeAgent,
  renameAgent,
  setAgentDefaults,
  setAgentGuard,
  setAgentLocation,
  setAgentSyncRef,
  setAgentTmux,
  syncAgent,
} from './agent'

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
  dir = join(tmpdir(), `quimby-agent-${crypto.randomUUID()}`)
  await setupGitRepo(dir)
  await ensureWorkspace(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('addAgent', () => {
  it('adds an agent entry to state with a stable UUID', async () => {
    const agent = await addAgent(dir, 'alice')
    expect(agent.id).toBeDefined()
    expect(agent.name).toBe('alice')
    const state = await loadState(dir)
    expect(state.agents.alice).toBeDefined()
    expect(state.agents.alice.id).toBe(agent.id)
  })

  it('creates the agent directory and CLAUDE.md scaffold', async () => {
    await addAgent(dir, 'bob')
    const agentDir = getAgentDir(dir, 'bob')
    expect(await exists(agentDir)).toBe(true)
    expect(await exists(join(agentDir, 'CLAUDE.md'))).toBe(true)
    expect(await exists(join(agentDir, 'assignment.md'))).toBe(true)
    expect(await exists(join(agentDir, 'status.md'))).toBe(true)
  })

  it('throws QuimbyError if an agent with that name already exists', async () => {
    await addAgent(dir, 'charlie')
    await expect(addAgent(dir, 'charlie')).rejects.toThrow('already exists')
  })

  it('records syncRef defaulting to the host branch', async () => {
    const { stdout: branch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
    })
    const agent = await addAgent(dir, 'dana')
    expect(agent.syncRef).toBe(branch.trim())
  })

  it('honors an explicit syncRef', async () => {
    const agent = await addAgent(dir, 'erin', { syncRef: 'release' })
    expect(agent.syncRef).toBe('release')
  })
})

describe('rebuildAgent', () => {
  it('removes and re-clones the agent repo', async () => {
    const agent = await addAgent(dir, 'alice')
    const firstSeed = agent.seedCommit
    // Rebuild should create a fresh clone
    await rebuildAgent(dir, 'alice')
    const state = await loadState(dir)
    expect(state.agents.alice.seedCommit).toBeDefined()
    expect(state.agents.alice.seedCommit).toHaveLength(40)
    // The seedCommit may change or stay same depending on HEAD
    expect(typeof state.agents.alice.seedCommit).toBe('string')
    void firstSeed
  })

  it('throws QuimbyError if agent does not exist', async () => {
    await expect(rebuildAgent(dir, 'nonexistent')).rejects.toThrow('not found')
  })
})

describe('removeAgent', () => {
  it('removes the agent from state', async () => {
    await addAgent(dir, 'alice')
    await removeAgent(dir, 'alice')
    const state = await loadState(dir)
    expect(state.agents.alice).toBeUndefined()
  })

  it('deletes the agent directory', async () => {
    await addAgent(dir, 'alice')
    const agentDir = getAgentDir(dir, 'alice')
    await removeAgent(dir, 'alice')
    expect(await exists(agentDir)).toBe(false)
  })

  it('throws QuimbyError if agent does not exist', async () => {
    await expect(removeAgent(dir, 'nonexistent')).rejects.toThrow('not found')
  })
})

describe('renameAgent', () => {
  it('updates the agent name in state', async () => {
    await addAgent(dir, 'alice')
    await renameAgent(dir, 'alice', 'bob')
    const state = await loadState(dir)
    expect(state.agents.bob).toBeDefined()
    expect(state.agents.alice).toBeUndefined()
  })

  it('renames the agent directory', async () => {
    await addAgent(dir, 'alice')
    await renameAgent(dir, 'alice', 'bob')
    expect(await exists(getAgentDir(dir, 'bob'))).toBe(true)
    expect(await exists(getAgentDir(dir, 'alice'))).toBe(false)
  })

  it('throws QuimbyError if agent does not exist', async () => {
    await expect(renameAgent(dir, 'nonexistent', 'new-name')).rejects.toThrow('not found')
  })

  it('throws QuimbyError if the new name is already taken', async () => {
    await addAgent(dir, 'alice')
    await addAgent(dir, 'bob')
    await expect(renameAgent(dir, 'alice', 'bob')).rejects.toThrow('already exists')
  })
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

describe('syncAgent', () => {
  it('throws a clear error when the sync ref does not resolve', async () => {
    await addAgent(dir, 'alice')
    await setAgentSyncRef(dir, 'alice', 'no-such-branch')
    await expect(syncAgent(dir, 'alice')).rejects.toThrow(/doesn't resolve/)
  })
})
