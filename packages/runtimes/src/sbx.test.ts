import { describe, expect, it, vi } from 'vitest'

const execa = vi.hoisted(() => vi.fn())
vi.mock('execa', () => ({ execa }))

import { sbx } from './sbx'

const ctx = {
  projectId: 'abcdef12-1234-5678-9abc-def012345678',
  agentId: '98765432-abcd-ef01-2345-6789abcdef01',
  agentName: 'alice',
  agentDir: '/root/.quimby/agents/alice',
  repoDir: '/root/.quimby/agents/alice/repo',
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
    expect(spec.cwd).toBe(ctx.agentDir)
  })

  it('runSpec includes the agent command', () => {
    const spec = sbx.runSpec(ctx, 'claude')
    expect(spec.args).toContain('claude')
  })

  it('runSpec names the sandbox with the agentId prefix, not the agent name', () => {
    const spec = sbx.runSpec(ctx, 'claude')
    const name = spec.args[spec.args.indexOf('--name') + 1]
    expect(name).toContain(ctx.agentId.slice(0, 8))
    // The friendly name must NOT be in the sandbox name — it changes on rename and
    // would needlessly break sandbox reuse.
    expect(name).not.toContain(ctx.agentName)
  })

  it('runSpec sandbox name is stable across a rename but changes on relocation', () => {
    const base = sbx.runSpec(ctx, 'claude')
    const baseName = base.args[base.args.indexOf('--name') + 1]
    // Rename only changes the display name; the UUID-keyed agentDir is unchanged,
    // so the sandbox name is identical and sbx reuses the same sandbox.
    const renamed = sbx.runSpec({ ...ctx, agentName: 'renamed' }, 'claude')
    expect(renamed.args[renamed.args.indexOf('--name') + 1]).toBe(baseName)
    // Relocation moves agentDir's absolute path, so the name changes and sbx makes
    // a fresh sandbox rather than reusing one pinned to a directory that has moved.
    const moved = sbx.runSpec({ ...ctx, agentDir: '/elsewhere/agents/x' }, 'claude')
    expect(moved.args[moved.args.indexOf('--name') + 1]).not.toBe(baseName)
  })

  it('runSpec sandbox name changes when the base entrypoint command changes', () => {
    const claude = sbx.runSpec(ctx, 'claude')
    const codex = sbx.runSpec(ctx, 'codex')
    expect(codex.args[codex.args.indexOf('--name') + 1]).not.toBe(
      claude.args[claude.args.indexOf('--name') + 1],
    )
  })

  it('runSpec and execSpec name the same sandbox for one agent', () => {
    const run = sbx.runSpec(ctx, 'claude')
    const exec = sbx.execSpec(ctx, 'claude --print')
    expect(run.args[run.args.indexOf('--name') + 1]).toBe(
      exec.args[exec.args.indexOf('--name') + 1],
    )
  })

  it('execSpec splits command and args with -- separator', () => {
    const spec = sbx.execSpec(ctx, 'claude --model "gpt 5"')
    expect(spec.command).toBe('sbx')
    expect(spec.args).toContain('--')
    expect(spec.args).toContain('--model')
    expect(spec.args).toContain('gpt 5')
  })

  it('setup resolves when the sbx CLI is present', async () => {
    execa.mockResolvedValueOnce({ stdout: 'sbx 1.0.0' })
    await expect(sbx.setup(ctx)).resolves.toBeUndefined()
  })

  it('setup throws a clear error when sbx is not on PATH', async () => {
    execa.mockRejectedValueOnce(Object.assign(new Error('spawn sbx ENOENT'), { code: 'ENOENT' }))
    await expect(sbx.setup(ctx)).rejects.toThrow(/isn't on your PATH/)
  })

  it('teardown runs a best-effort `sbx rm <sandbox>`, swallowing errors', async () => {
    execa.mockRejectedValueOnce(new Error('no such sandbox'))
    await expect(sbx.teardown(ctx)).resolves.toBeUndefined()
    expect(execa).toHaveBeenCalledWith('sbx', expect.arrayContaining(['rm']))
  })

  it('teardownSpec returns the `sbx rm <sandbox>` command as data without executing', () => {
    execa.mockClear()
    const spec = sbx.teardownSpec(ctx)
    expect(spec?.command).toBe('sbx')
    // With no launch command available, teardown targets the legacy commandless sandbox name.
    expect(spec?.args).toEqual(['rm', expect.stringContaining(ctx.agentId.slice(0, 8))])
    expect(execa).not.toHaveBeenCalled()
  })
})
