import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentDir } from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace, loadState } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addAgent, rebuildAgent, removeAgent, renameAgent } from './lifecycle'

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
  dir = join(tmpdir(), `quimby-lifecycle-${crypto.randomUUID()}`)
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
    const agent = await addAgent(dir, 'bob')
    const agentDir = getAgentDir(dir, agent.id)
    expect(await exists(agentDir)).toBe(true)
    expect(await exists(join(agentDir, 'CLAUDE.md'))).toBe(true)
    expect(await exists(join(agentDir, 'assignment.md'))).toBe(true)
    expect(await exists(join(agentDir, 'status.md'))).toBe(true)
  })

  it('honors an explicit syncRef', async () => {
    const agent = await addAgent(dir, 'erin', { syncRef: 'release' })
    expect(agent.syncRef).toBe('release')
  })

  it('records syncRef defaulting to the host branch', async () => {
    const { stdout: branch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
    })
    const agent = await addAgent(dir, 'dana')
    expect(agent.syncRef).toBe(branch.trim())
  })

  it('throws QuimbyError if an agent with that name already exists', async () => {
    await addAgent(dir, 'charlie')
    await expect(addAgent(dir, 'charlie')).rejects.toThrow('already exists')
  })

  it('throws QuimbyError for an agent name containing dots', async () => {
    await expect(addAgent(dir, 'my.agent')).rejects.toThrow('Invalid agent name')
  })

  it('throws QuimbyError for an agent name that starts with a hyphen', async () => {
    await expect(addAgent(dir, '-bad')).rejects.toThrow('Invalid agent name')
  })

  it('throws QuimbyError for the reserved name "host"', async () => {
    await expect(addAgent(dir, 'host')).rejects.toThrow('reserved')
  })
})

describe('rebuildAgent', () => {
  it('removes and re-clones the agent repo', async () => {
    const agent = await addAgent(dir, 'alice')
    const firstSeed = agent.seedCommit
    await rebuildAgent(dir, 'alice')
    const state = await loadState(dir)
    expect(state.agents.alice.seedCommit).toBeDefined()
    expect(state.agents.alice.seedCommit).toHaveLength(40)
    expect(typeof state.agents.alice.seedCommit).toBe('string')
    void firstSeed
  })

  it('throws QuimbyError if agent does not exist', async () => {
    await expect(rebuildAgent(dir, 'nonexistent')).rejects.toThrow('not found')
  })
})

describe('removeAgent', () => {
  it('deletes the agent directory', async () => {
    await addAgent(dir, 'alice')
    const agentDir = getAgentDir(dir, 'alice')
    await removeAgent(dir, 'alice')
    expect(await exists(agentDir)).toBe(false)
  })

  it('removes the agent from state', async () => {
    await addAgent(dir, 'alice')
    await removeAgent(dir, 'alice')
    const state = await loadState(dir)
    expect(state.agents.alice).toBeUndefined()
  })

  it('throws QuimbyError if agent does not exist', async () => {
    await expect(removeAgent(dir, 'nonexistent')).rejects.toThrow('not found')
  })
})

describe('renameAgent', () => {
  it('relabels the agent without moving its UUID-keyed directory', async () => {
    const agent = await addAgent(dir, 'alice')
    const agentDir = getAgentDir(dir, agent.id)
    expect(await exists(agentDir)).toBe(true)

    await renameAgent(dir, 'alice', 'bob')

    // The directory is keyed by the stable id, so a rename never moves it — the
    // sandbox and tmux session bound to that path survive. Only the name changes.
    expect(await exists(agentDir)).toBe(true)
    const state = await loadState(dir)
    expect(state.agents.bob).toBeDefined()
    expect(state.agents.bob.id).toBe(agent.id)
    expect(state.agents.alice).toBeUndefined()
  })

  it('throws QuimbyError if agent does not exist', async () => {
    await expect(renameAgent(dir, 'nonexistent', 'new-name')).rejects.toThrow('not found')
  })

  it('throws QuimbyError if the new name is already taken', async () => {
    await addAgent(dir, 'alice')
    await addAgent(dir, 'bob')
    await expect(renameAgent(dir, 'alice', 'bob')).rejects.toThrow('already exists')
  })

  it('updates the agent name in state', async () => {
    await addAgent(dir, 'alice')
    await renameAgent(dir, 'alice', 'bob')
    const state = await loadState(dir)
    expect(state.agents.bob).toBeDefined()
    expect(state.agents.alice).toBeUndefined()
  })
})
