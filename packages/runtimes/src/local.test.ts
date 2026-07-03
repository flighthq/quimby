import { describe, expect, it } from 'vitest'

import { local } from './local'

const ctx = {
  projectId: 'proj-id',
  agentId: 'agent-id',
  agentName: 'alice',
  agentDir: '/root/.quimby/agents/alice',
  repoDir: '/root/.quimby/agents/alice/repo',
  repoRoot: '/root',
}

describe('local', () => {
  it('has the name "local"', () => {
    expect(local.type).toBe('local')
  })

  it('runSpec returns a RunSpec with command, args, and cwd', () => {
    const spec = local.runSpec(ctx, 'claude --model "gpt 5"')
    expect(spec.command).toBe('claude')
    expect(spec.args).toEqual(['--model', 'gpt 5'])
    expect(spec.cwd).toBe(ctx.agentDir)
  })

  it('runSpec handles a single-word command', () => {
    const spec = local.runSpec(ctx, 'claude')
    expect(spec.command).toBe('claude')
    expect(spec.args).toEqual([])
  })

  it('execSpec returns same structure as runSpec', () => {
    const spec = local.execSpec(ctx, 'claude --dangerously-skip-permissions')
    expect(spec.command).toBe('claude')
    expect(spec.cwd).toBe(ctx.agentDir)
  })

  it('setup resolves without error', async () => {
    await expect(local.setup(ctx)).resolves.toBeUndefined()
  })

  it('teardown resolves without error', async () => {
    await expect(local.teardown(ctx)).resolves.toBeUndefined()
  })
})
