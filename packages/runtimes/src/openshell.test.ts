import { describe, expect, it, vi } from 'vitest'

const execa = vi.hoisted(() => vi.fn())
vi.mock('execa', () => ({ execa }))

import { openshell } from './openshell'

const ctx = {
  projectId: 'proj-id',
  agentId: 'agent-id',
  agentName: 'alice',
  agentDir: '/root/.quimby/agents/alice',
  repoDir: '/root/.quimby/agents/alice/repo',
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
    expect(spec.cwd).toBe(ctx.agentDir)
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

  it('setup resolves when the openshell CLI is present', async () => {
    execa.mockResolvedValueOnce({ stdout: 'openshell 1.0.0' })
    await expect(openshell.setup(ctx)).resolves.toBeUndefined()
  })

  it('setup throws a clear error when openshell is not on PATH', async () => {
    execa.mockRejectedValueOnce(
      Object.assign(new Error('spawn openshell ENOENT'), { code: 'ENOENT' }),
    )
    await expect(openshell.setup(ctx)).rejects.toThrow(/isn't on your PATH/)
  })

  it('teardown runs a best-effort sandbox removal, swallowing errors', async () => {
    execa.mockRejectedValueOnce(new Error('no such sandbox'))
    await expect(openshell.teardown(ctx)).resolves.toBeUndefined()
    expect(execa).toHaveBeenCalledWith('openshell', expect.arrayContaining(['sandbox', 'rm']))
  })
})
