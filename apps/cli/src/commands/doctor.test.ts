import { describe, expect, it, vi } from 'vitest'

const execa = vi.hoisted(() => vi.fn(async () => ({ stdout: '' })))
const transport = vi.hoisted(() => ({
  exec: vi.fn(async () => ''),
}))

vi.mock('execa', () => ({ execa }))
vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: vi.fn(() => transport),
}))
vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    repoRoot: '/repo',
    state: {
      id: 'proj',
      agents: {
        local: {
          id: 'l1',
          name: 'local',
          location: { type: 'local' },
          defaults: { runtime: 'local', entrypoint: 'codex --model "gpt 5"' },
        },
        remote: {
          id: 'r1',
          name: 'remote',
          location: { type: 'ssh', host: 'me@gpu' },
          defaults: { runtime: 'sbx', entrypoint: 'claude' },
        },
      },
    },
  })),
  loadQuimbyConfig: vi.fn(async () => ({
    defaults: { entrypoint: 'claude' },
    runtimeProfiles: {
      ollama: {
        runtime: 'openshell',
        entrypoint: 'codex',
        provider: 'ollama',
        ollama: { host: 'http://gpu:11434' },
      },
    },
    hosts: { gpu: { host: 'me@gpu' } },
  })),
}))

import cmd from './doctor'

describe('doctor', () => {
  it('is a function', () => {
    expect(typeof cmd.run).toBe('function')
  })

  it('checks local core and entrypoint commands', async () => {
    execa.mockClear()
    await cmd.run!({ args: { agent: 'local' } } as never)
    const probes = execa.mock.calls.map((c) => (c as unknown as [string, string[]])[1][1])
    expect(probes).toContain('command -v git')
    expect(probes).toContain('command -v codex')
    expect(probes).not.toContain('command -v tmux')
  })

  it('checks remote transport and runtime CLI, but not a sandboxed entrypoint', async () => {
    transport.exec.mockClear()
    await cmd.run!({ args: { agent: 'remote' } } as never)
    const probes = transport.exec.mock.calls.map((c) => (c as unknown as [string])[0])
    expect(probes).toEqual(
      expect.arrayContaining([
        'command -v git',
        'command -v rsync',
        'command -v tmux',
        'command -v sbx',
      ]),
    )
    // The entrypoint runs inside the sbx sandbox, not on the host, so it is not probed.
    expect(probes).not.toContain('command -v claude')
  })

  it('can check a private host alias without an agent', async () => {
    transport.exec.mockClear()
    await cmd.run!({ args: { hostAlias: 'gpu', runtime: 'sbx' } } as never)
    expect(transport.exec.mock.calls.map((c) => (c as unknown as [string])[0])).toContain(
      'command -v sbx',
    )
  })

  it('checks runtime profile provider dependencies but not the sandboxed entrypoint', async () => {
    transport.exec.mockClear()
    await cmd.run!({ args: { hostAlias: 'gpu', runtimeProfile: 'ollama' } } as never)
    const probes = transport.exec.mock.calls.map((c) => (c as unknown as [string])[0])
    expect(probes).toEqual(expect.arrayContaining(['command -v openshell', 'command -v ollama']))
    // codex is the entrypoint, run inside the openshell runtime — not a host tool.
    expect(probes).not.toContain('command -v codex')
  })

  it('fails when a dependency is missing', async () => {
    execa.mockRejectedValueOnce(new Error('missing'))
    await expect(cmd.run!({ args: { agent: 'local' } } as never)).rejects.toThrow(
      'missing dependencies',
    )
  })
})
