import { describe, it, expect } from 'vitest'
import { dockerSandboxAdapter } from '../../src/runtime/docker-sandbox.js'
import { openshellAdapter } from '../../src/runtime/openshell.js'
import { remoteAdapter } from '../../src/runtime/remote.js'
import { resolveAdapter } from '../../src/runtime/resolve.js'

describe('dockerSandboxAdapter', () => {
  describe('buildLaunchSpec', () => {
    it('parses argv into command and args', () => {
      const spec = dockerSandboxAdapter.buildLaunchSpec(
        ['sbx', 'run', 'claude', '--network-allow', 'api.anthropic.com'],
        '/sandbox/path',
      )
      expect(spec.command).toBe('sbx')
      expect(spec.args).toEqual(['run', 'claude', '--network-allow', 'api.anthropic.com'])
      expect(spec.cwd).toBe('/sandbox/path')
      expect(spec.detached).toBe(true)
    })

    it('sets stdout/stderr log paths', () => {
      const spec = dockerSandboxAdapter.buildLaunchSpec(['cmd'], '/sandbox')
      expect(spec.stdoutLog).toContain('.sandbox/runtime.stdout.log')
      expect(spec.stderrLog).toContain('.sandbox/runtime.stderr.log')
    })
  })
})

describe('openshellAdapter', () => {
  describe('buildLaunchSpec', () => {
    it('produces a launch spec', () => {
      const spec = openshellAdapter.buildLaunchSpec(['openshell', 'start'], '/path')
      expect(spec.command).toBe('openshell')
      expect(spec.detached).toBe(true)
    })
  })
})

describe('remoteAdapter', () => {
  describe('buildLaunchSpec', () => {
    it('produces a launch spec for remote commands', () => {
      const spec = remoteAdapter.buildLaunchSpec(['ssh', 'user@host', 'sbx', 'run'], '/remote/path')
      expect(spec.command).toBe('ssh')
      expect(spec.args).toEqual(['user@host', 'sbx', 'run'])
      expect(spec.detached).toBe(true)
    })
  })
})

describe('resolveAdapter', () => {
  it('resolves docker-sandbox adapter', () => {
    const adapter = resolveAdapter('docker-sandbox')
    expect(adapter.type).toBe('docker-sandbox')
  })

  it('resolves openshell adapter', () => {
    const adapter = resolveAdapter('openshell')
    expect(adapter.type).toBe('openshell')
  })

  it('resolves remote adapter', () => {
    const adapter = resolveAdapter('remote')
    expect(adapter.type).toBe('remote')
  })

  it('throws for unknown type', () => {
    expect(() => resolveAdapter('unknown')).toThrow('Unknown runtime type')
  })
})
