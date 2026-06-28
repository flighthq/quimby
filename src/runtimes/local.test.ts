import { describe, expect, it } from 'vitest'

import { local } from './local'

const ctx = {
  projectId: 'proj-id',
  workerId: 'worker-id',
  workerName: 'alice',
  workerDir: '/root/.quimby/workers/alice',
  repoDir: '/root/.quimby/workers/alice/repo',
  repoRoot: '/root',
}

describe('local', () => {
  it('has the name "local"', () => {
    expect(local.type).toBe('local')
  })

  it('runSpec returns a RunSpec with command, args, and cwd', () => {
    const spec = local.runSpec(ctx, 'claude --resume')
    expect(spec.command).toBe('claude')
    expect(spec.args).toEqual(['--resume'])
    expect(spec.cwd).toBe(ctx.workerDir)
  })

  it('runSpec handles a single-word command', () => {
    const spec = local.runSpec(ctx, 'claude')
    expect(spec.command).toBe('claude')
    expect(spec.args).toEqual([])
  })

  it('execSpec returns same structure as runSpec', () => {
    const spec = local.execSpec(ctx, 'claude --dangerously-skip-permissions')
    expect(spec.command).toBe('claude')
    expect(spec.cwd).toBe(ctx.workerDir)
  })

  it('setup resolves without error', async () => {
    await expect(local.setup(ctx)).resolves.toBeUndefined()
  })

  it('teardown resolves without error', async () => {
    await expect(local.teardown(ctx)).resolves.toBeUndefined()
  })
})
