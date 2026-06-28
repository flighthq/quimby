import { describe, expect, it } from 'vitest'

import { buildContext, getRuntime, runtimeTypes } from './index'

describe('runtimeTypes', () => {
  it('includes local, sbx, and openshell', () => {
    expect(runtimeTypes).toContain('local')
    expect(runtimeTypes).toContain('sbx')
    expect(runtimeTypes).toContain('openshell')
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

describe('buildContext', () => {
  it('returns a RuntimeContext with workerDir, repoDir, and claudeMdPath', () => {
    const ctx = buildContext('/root', 'alice', 'proj-id', 'worker-id')
    expect(ctx.workerDir).toContain('alice')
    expect(ctx.repoDir).toContain('alice')
    expect(ctx.repoRoot).toBe('/root')
    expect(ctx.workerName).toBe('alice')
    expect(ctx.projectId).toBe('proj-id')
    expect(ctx.workerId).toBe('worker-id')
  })

  it('workerDir and repoDir are under repoRoot', () => {
    const ctx = buildContext('/root', 'bob', 'proj', 'worker')
    expect(ctx.workerDir.startsWith('/root')).toBe(true)
    expect(ctx.repoDir.startsWith('/root')).toBe(true)
  })
})
