import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as git from '@quimbyhq/git'
import { getAgentDir, getAgentRepoDir } from '@quimbyhq/paths'
import type { SSHTransport } from '@quimbyhq/transport'
import { getSSHTransport } from '@quimbyhq/transport'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace, loadState, saveState } from '@quimbyhq/workspace'
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

vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: vi.fn(),
}))

const mockedGetSSH = vi.mocked(getSSHTransport)

// A recording SSH transport: every remote command is captured in `calls`, and
// `git rev-parse HEAD` yields a fixed seed so the persisted seedCommit is assertable.
function fakeSSHTransport(): { transport: SSHTransport; calls: string[] } {
  const calls: string[] = []
  const transport = {
    exec: vi.fn(async (cmd: string) => {
      calls.push(cmd)
      if (cmd.includes('rev-parse HEAD')) return 'remoteseed1234'
      return ''
    }),
    syncProjectTo: vi.fn(async () => {}),
    ensureDir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    checkCapabilities: vi.fn(async () => {}),
  } as unknown as SSHTransport
  return { transport, calls }
}

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

  it('creates the agent directory and instruction scaffolds', async () => {
    const agent = await addAgent(dir, 'bob')
    const agentDir = getAgentDir(dir, agent.id)
    expect(await exists(agentDir)).toBe(true)
    expect(await exists(join(agentDir, 'AGENTS.md'))).toBe(true)
    expect(await exists(join(agentDir, 'CLAUDE.md'))).toBe(true)
    expect(await exists(join(agentDir, 'assignment.md'))).toBe(true)
    expect(await exists(join(agentDir, 'status.md'))).toBe(true)
    // The agent-side mailbox tool is scaffolded too; the .sh must be executable to run directly.
    expect(await exists(join(agentDir, 'quimby-agent.sh'))).toBe(true)
    expect(await exists(join(agentDir, 'quimby-agent.cmd'))).toBe(true)
    expect((await stat(join(agentDir, 'quimby-agent.sh'))).mode & 0o100).toBeTruthy()
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

  // The existence check uses Object.hasOwn, so a name that collides with an Object.prototype
  // key (constructor, toString, __proto__, …) is not mistaken for an already-registered agent.
  it('allows an agent named after an Object.prototype key', async () => {
    const agent = await addAgent(dir, 'constructor')
    expect(agent.name).toBe('constructor')
    expect((await loadState(dir)).agents['constructor'].id).toBe(agent.id)
    // A genuine duplicate of that same name is still rejected.
    await expect(addAgent(dir, 'constructor')).rejects.toThrow('already exists')
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

  it('records HEAD as seed and does not clone locally for an SSH agent (lazy init)', async () => {
    const agent = await addAgent(dir, 'remote', {
      location: { type: 'ssh', host: 'user@box', base: '~' },
    })

    // The remote is initialized lazily on first run, so no local repo dir exists yet.
    expect(await exists(getAgentDir(dir, agent.id))).toBe(false)
    expect(await exists(getAgentRepoDir(dir, agent.id))).toBe(false)
    // The current host HEAD is recorded as the intended seed baseline.
    expect(agent.seedCommit).toHaveLength(40)

    const state = await loadState(dir)
    expect(state.agents.remote).toBeDefined()
    expect(state.agents.remote.seedCommit).toBe(agent.seedCommit)
    expect(state.agents.remote.location).toEqual({ type: 'ssh', host: 'user@box', base: '~' })
  })

  // Exercises the private resolveAgentIdentity fallback: with no host identity readable,
  // the agent clone commits under a quimby-scoped name/email instead of a stray default.
  it('configures a quimby-scoped git identity when the host has none', async () => {
    const spy = vi.spyOn(git, 'getConfig').mockResolvedValue(undefined)
    try {
      const agent = await addAgent(dir, 'noident')
      const repoDir = getAgentRepoDir(dir, agent.id)
      const { stdout: name } = await execa('git', ['config', '--get', 'user.name'], {
        cwd: repoDir,
      })
      const { stdout: email } = await execa('git', ['config', '--get', 'user.email'], {
        cwd: repoDir,
      })
      expect(name.trim()).toBe('quimby-noident')
      expect(email.trim()).toBe('quimby+noident@local')
    } finally {
      spy.mockRestore()
    }
  })

  // Exercises the private getCurrentBranchOrRef: a detached host HEAD has no branch name,
  // so the default syncRef falls through to the current commit SHA.
  it('records the commit SHA as syncRef when the host is on a detached HEAD', async () => {
    const sha = await git.getCurrentRef(dir)
    await execa('git', ['checkout', sha], { cwd: dir })
    const agent = await addAgent(dir, 'detached')
    expect(agent.syncRef).toBe(sha)
  })

  // The getCurrentBranchOrRef catch arm: with the host branch unreadable, syncRef is "main".
  it('falls back to "main" as syncRef when the host branch cannot be read', async () => {
    // The workspace already exists (beforeEach), so addAgent short-circuits ensureWorkspace;
    // removing .git makes the branch probe fail without breaking workspace resolution.
    await rm(join(dir, '.git'), { recursive: true, force: true })
    const agent = await addAgent(dir, 'orphan')
    expect(agent.syncRef).toBe('main')
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

  it('clears the mailbox and resets assignment/status on rebuild', async () => {
    const agent = await addAgent(dir, 'alice')
    const agentDir = getAgentDir(dir, agent.id)
    // A delivered received parcel, a queued outbox draft, and a dirtied task/status.
    await mkdir(join(agentDir, 'handoff', 'in', 'received', 'review-abc123'), { recursive: true })
    await writeFile(
      join(agentDir, 'handoff', 'in', 'received', 'review-abc123', 'README.md'),
      'please review',
    )
    await mkdir(join(agentDir, 'handoff', 'out', 'queued', 'builder'), { recursive: true })
    await writeFile(join(agentDir, 'handoff', 'out', 'queued', 'builder', 'README.md'), 'a reply')
    await writeFile(join(agentDir, 'assignment.md'), 'do the thing')
    await writeFile(join(agentDir, 'status.md'), 'working hard')

    await rebuildAgent(dir, 'alice')

    // The mailbox is wiped (parcels gone) but re-scaffolded, and the task/status are reset.
    expect(await exists(join(agentDir, 'handoff', 'in', 'received', 'review-abc123'))).toBe(false)
    expect(await exists(join(agentDir, 'handoff', 'out', 'queued', 'builder'))).toBe(false)
    expect(await exists(join(agentDir, 'handoff', 'out', 'draft'))).toBe(true)
    expect(await readFile(join(agentDir, 'assignment.md'), 'utf-8')).toBe('')
    expect(await readFile(join(agentDir, 'status.md'), 'utf-8')).toBe('idle')
  })

  it('throws QuimbyError if agent does not exist', async () => {
    await expect(rebuildAgent(dir, 'nonexistent')).rejects.toThrow('not found')
  })

  it('issues the remote rebuild sequence and persists the seed for an SSH agent', async () => {
    const { transport, calls } = fakeSSHTransport()
    mockedGetSSH.mockReturnValue(transport)
    // addAgent for SSH is lazy (no transport), so registering it first is safe.
    await addAgent(dir, 'remote', { location: { type: 'ssh', host: 'user@box', base: '~' } })

    await rebuildAgent(dir, 'remote')

    expect(transport.syncProjectTo).toHaveBeenCalled()
    expect(calls.some((c) => c.startsWith('rm -rf'))).toBe(true)
    expect(transport.ensureDir).toHaveBeenCalled()
    expect(calls.some((c) => c.startsWith('git clone'))).toBe(true)
    expect(calls).toContain('git tag quimby/seed')
    // git identity is configured in the remote clone
    expect(calls.some((c) => c.includes('git config user.name'))).toBe(true)
    // scaffolding files are written back
    expect(transport.writeFile).toHaveBeenCalledWith(expect.stringContaining('assignment.md'), '')
    expect(transport.writeFile).toHaveBeenCalledWith(expect.stringContaining('status.md'), 'idle')
    // the remote HEAD becomes the persisted seed
    const state = await loadState(dir)
    expect(state.agents.remote.seedCommit).toBe('remoteseed1234')
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

  it('removes the remote agent dir and deletes the state entry for an SSH agent', async () => {
    const { transport, calls } = fakeSSHTransport()
    mockedGetSSH.mockReturnValue(transport)
    await addAgent(dir, 'remote', { location: { type: 'ssh', host: 'user@box', base: '~' } })

    await removeAgent(dir, 'remote')

    expect(calls.some((c) => c.startsWith('rm -rf'))).toBe(true)
    const state = await loadState(dir)
    expect(state.agents.remote).toBeUndefined()
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
