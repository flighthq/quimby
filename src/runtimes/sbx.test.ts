import { describe, expect, it } from 'vitest'

import { sbx } from './sbx'

const ctx = {
  projectId: 'abcdef12-1234-5678-9abc-def012345678',
  workerId: '98765432-abcd-ef01-2345-6789abcdef01',
  workerName: 'alice',
  workerDir: '/root/.quimby/workers/alice',
  repoDir: '/root/.quimby/workers/alice/repo',
  repoRoot: '/root',
}

describe('sbx', () => {
  it('has the name "sbx"', () => {
    expect(sbx.type).toBe('sbx')
  })

  it('runSpec builds a sbx run command', () => {
    const spec = sbx.runSpec(ctx, 'claude')
    expect(spec.command).toBe('sbx')
    expect(spec.args[0]).toBe('run')
    expect(spec.args).toContain('--name')
    expect(spec.cwd).toBe(ctx.workerDir)
  })

  it('runSpec includes the agent command', () => {
    const spec = sbx.runSpec(ctx, 'claude')
    expect(spec.args).toContain('claude')
  })

  it('runSpec sandbox name includes project and worker ID prefixes', () => {
    const spec = sbx.runSpec(ctx, 'claude')
    const nameIdx = spec.args.indexOf('--name')
    const sandboxName = spec.args[nameIdx + 1]
    expect(sandboxName).toContain('claude')
    expect(sandboxName).toContain(ctx.projectId.slice(0, 8))
    expect(sandboxName).toContain(ctx.workerId.slice(0, 8))
  })

  it('execSpec splits command and args with -- separator', () => {
    const spec = sbx.execSpec(ctx, 'claude --dangerously-skip-permissions')
    expect(spec.command).toBe('sbx')
    expect(spec.args).toContain('--')
    expect(spec.args).toContain('--dangerously-skip-permissions')
  })

  it('setup resolves without error', async () => {
    await expect(sbx.setup(ctx)).resolves.toBeUndefined()
  })

  it('teardown resolves without error', async () => {
    await expect(sbx.teardown(ctx)).resolves.toBeUndefined()
  })
})
