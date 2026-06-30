import { describe, expect, it } from 'vitest'

import { buildContext, getRuntime, runtimeTypes } from './index'

describe('buildContext', () => {
  it('returns a RuntimeContext with agentDir, repoDir, and claudeMdPath', () => {
    const ctx = buildContext('/root', 'alice', 'proj-id', 'agent-id')
    // Directories are keyed by the agent's stable id, not its name, so a rename
    // never moves them.
    expect(ctx.agentDir).toContain('agent-id')
    expect(ctx.agentDir).not.toContain('alice')
    expect(ctx.repoDir).toContain('agent-id')
    expect(ctx.repoRoot).toBe('/root')
    expect(ctx.agentName).toBe('alice')
    expect(ctx.projectId).toBe('proj-id')
    expect(ctx.agentId).toBe('agent-id')
  })

  it('agentDir and repoDir are under repoRoot', () => {
    const ctx = buildContext('/root', 'bob', 'proj', 'agent')
    expect(ctx.agentDir.startsWith('/root')).toBe(true)
    expect(ctx.repoDir.startsWith('/root')).toBe(true)
  })
})

describe('getRuntime', () => {
  it('returns the correct adapter for local', () => {
    const adapter = getRuntime('local')
    expect(adapter.type).toBe('local')
  })

  it('returns the correct adapter for sbx', () => {
    const adapter = getRuntime('sbx')
    expect(adapter.type).toBe('sbx')
  })

  it('returns the correct adapter for openshell', () => {
    const adapter = getRuntime('openshell')
    expect(adapter.type).toBe('openshell')
  })

  it('throws for an unknown runtime type', () => {
    expect(() => getRuntime('unknown' as never)).toThrow('Unknown runtime')
  })
})

describe('runtimeTypes', () => {
  it('includes local, sbx, and openshell', () => {
    expect(runtimeTypes).toContain('local')
    expect(runtimeTypes).toContain('sbx')
    expect(runtimeTypes).toContain('openshell')
  })
})
