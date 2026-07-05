import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ENTRYPOINT,
  DEFAULT_RUNTIME,
  resolveRuntimeEnv,
  resolveRuntimeProfile,
  resolveRuntimeRequirements,
  resolveRuntimeSelection,
} from './profile'

const config = {
  runtimeProfiles: {
    sbxClaude: {
      runtime: 'sbx',
      entrypoint: 'claude',
      args: ['--dangerously-skip-permissions'],
      requiredTools: ['node'],
    },
    openshellOllama: {
      runtime: 'openshell',
      entrypoint: 'codex',
      args: ['--model', 'qwen 2.5 coder'],
      provider: 'ollama',
      ollama: { host: 'http://gpu:11434' },
      env: { CODEX_HOME: '~/.codex' },
    },
  },
}

describe('resolveRuntimeEnv', () => {
  it('adds OLLAMA_HOST only for ollama profiles with a host', () => {
    expect(resolveRuntimeEnv({ provider: 'ollama', ollama: { host: 'http://x' } })).toEqual({
      OLLAMA_HOST: 'http://x',
    })
    expect(resolveRuntimeEnv({ provider: 'other' })).toEqual({})
  })
})

describe('resolveRuntimeProfile', () => {
  it('returns undefined when no runtime profile is named', () => {
    expect(resolveRuntimeProfile(config, undefined)).toBeUndefined()
  })

  it('resolves a named runtime profile from quimby config', () => {
    expect(resolveRuntimeProfile(config, 'sbxClaude')).toMatchObject({ runtime: 'sbx' })
  })

  it('throws a clear error for missing runtime profiles', () => {
    expect(() => resolveRuntimeProfile(config, 'missing')).toThrow(
      'Runtime profile "missing" not found',
    )
  })
})

describe('resolveRuntimeRequirements', () => {
  it('dedupes runtime, provider, and explicit tools', () => {
    expect(
      resolveRuntimeRequirements({
        runtime: 'openshell',
        entrypoint: 'openshell --version',
        profile: { provider: 'ollama', requiredTools: ['ollama', 'git'] },
      }),
    ).toEqual(['openshell', 'ollama', 'git'])
  })

  it('drops a sandboxed entrypoint listed in requiredTools, keeping the runtime CLI', () => {
    // A profile that lists its own entrypoint as a required tool: `claude` runs inside the
    // sbx sandbox, not on the host, so only `sbx` is a genuine host dependency.
    expect(
      resolveRuntimeRequirements({
        runtime: 'sbx',
        entrypoint: 'claude',
        profile: { requiredTools: ['claude'] },
      }),
    ).toEqual(['sbx'])
  })

  it('keeps genuine host tools alongside a filtered sandboxed entrypoint', () => {
    expect(
      resolveRuntimeRequirements({
        runtime: 'sbx',
        entrypoint: 'claude --dangerously-skip-permissions',
        profile: { requiredTools: ['claude', 'node'] },
      }),
    ).toEqual(['sbx', 'node'])
  })

  it('keeps the entrypoint for the local runtime, where it runs on the host', () => {
    expect(
      resolveRuntimeRequirements({
        runtime: 'local',
        entrypoint: 'claude',
        profile: { requiredTools: ['claude'] },
      }),
    ).toEqual(['claude'])
  })
})

describe('resolveRuntimeSelection', () => {
  it('uses the built-in local claude default without config', () => {
    expect(resolveRuntimeSelection()).toMatchObject({
      runtime: DEFAULT_RUNTIME,
      entrypoint: DEFAULT_ENTRYPOINT,
      runtimeLabel: '',
    })
  })

  it('applies profile runtime, entrypoint args, env, and dependency tools', () => {
    const selection = resolveRuntimeSelection({
      config,
      saved: { runtimeProfile: 'openshellOllama' },
    })
    expect(selection.runtime).toBe('openshell')
    expect(selection.entrypoint).toBe("codex --model 'qwen 2.5 coder'")
    expect(selection.env).toEqual({
      CODEX_HOME: '~/.codex',
      OLLAMA_HOST: 'http://gpu:11434',
    })
    expect(selection.requiredTools).toEqual(['openshell', 'ollama'])
    expect(selection.runtimeLabel).toBe(' [openshell]')
  })

  it('lets explicit runtime and command override the profile launch command', () => {
    const selection = resolveRuntimeSelection({
      config,
      saved: { runtimeProfile: 'openshellOllama' },
      runtime: 'local',
      cmd: 'node ./agent.js',
    })
    expect(selection.runtime).toBe('local')
    expect(selection.entrypoint).toBe('node ./agent.js')
    expect(selection.requiredTools).toEqual(['ollama'])
  })

  it('lets saved runtime and entrypoint override a saved profile while keeping profile env', () => {
    const selection = resolveRuntimeSelection({
      config,
      saved: {
        runtimeProfile: 'openshellOllama',
        runtime: 'sbx',
        entrypoint: 'claude',
      },
    })
    expect(selection.runtime).toBe('sbx')
    expect(selection.entrypoint).toBe("claude --model 'qwen 2.5 coder'")
    expect(selection.env.OLLAMA_HOST).toBe('http://gpu:11434')
  })

  it('throws for unknown runtimes from explicit overrides or profiles', () => {
    expect(() => resolveRuntimeSelection({ runtime: 'bogus' })).toThrow('Unknown runtime "bogus"')
    expect(() =>
      resolveRuntimeSelection({
        config: { runtimeProfiles: { bad: { runtime: 'bogus' } } },
        saved: { runtimeProfile: 'bad' },
      }),
    ).toThrow('Unknown runtime "bogus"')
  })
})
