import { describe, expect, it } from 'vitest'

import { openshell } from './openshell'

const ctx = {
  projectId: 'proj-id',
  workerId: 'worker-id',
  workerName: 'alice',
  workerDir: '/root/.quimby/workers/alice',
  repoDir: '/root/.quimby/workers/alice/repo',
  repoRoot: '/root',
}

describe('openshell', () => {
  it('has the name "openshell"', () => {
    expect(openshell.type).toBe('openshell')
  })

  it('runSpec builds the correct openshell command', () => {
    const spec = openshell.runSpec(ctx, 'claude')
    expect(spec.command).toBe('openshell')
    expect(spec.args).toContain('sandbox')
    expect(spec.args).toContain('create')
    expect(spec.args).toContain('--')
    expect(spec.args).toContain('claude')
    expect(spec.cwd).toBe(ctx.workerDir)
  })

  it('execSpec splits command into parts', () => {
    const spec = openshell.execSpec(ctx, 'claude --dangerously-skip-permissions')
    expect(spec.command).toBe('openshell')
    expect(spec.args).toContain('sandbox')
    expect(spec.args).toContain('create')
    expect(spec.args).toContain('--')
    expect(spec.args).toContain('claude')
    expect(spec.args).toContain('--dangerously-skip-permissions')
  })

  it('setup resolves without error', async () => {
    await expect(openshell.setup(ctx)).resolves.toBeUndefined()
  })

  it('teardown resolves without error', async () => {
    await expect(openshell.teardown(ctx)).resolves.toBeUndefined()
  })
})
