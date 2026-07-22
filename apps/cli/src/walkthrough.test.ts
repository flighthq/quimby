import type { QuimbyConfig } from '@quimbyhq/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveWalkthroughConfig, runAgentWalkthrough } from './walkthrough'

const h = vi.hoisted(() => {
  const CANCEL = Symbol('cancel')
  const queue: unknown[] = []
  return { CANCEL, queue, next: () => Promise.resolve(queue.shift()) }
})

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => value === h.CANCEL,
  select: () => h.next(),
  text: () => h.next(),
  confirm: () => h.next(),
}))

const configAware: QuimbyConfig = {
  roles: { builder: { runtimeProfile: 'claude-sbx' } },
  runtimeProfiles: { 'claude-sbx': {}, 'codex-sbx': {} },
  hosts: { gpu: { host: 'me@gpu' } },
}

describe('resolveWalkthroughConfig', () => {
  it('maps a role engine to a role reference with no pin or flattened defaults', () => {
    expect(resolveWalkthroughConfig({ role: 'builder', engine: { source: 'role' } })).toEqual({
      role: 'builder',
      location: { type: 'local' },
    })
  })

  it('maps a profile engine to a pin (keeping any role), never flattened defaults', () => {
    expect(
      resolveWalkthroughConfig({
        role: 'builder',
        engine: { source: 'profile', runtimeProfile: 'codex-sbx' },
      }),
    ).toEqual({ role: 'builder', runtimeProfile: 'codex-sbx', location: { type: 'local' } })
  })

  it('maps a manual engine to flattened defaults with no role or pin', () => {
    expect(
      resolveWalkthroughConfig({
        engine: { source: 'manual', runtime: 'sbx', entrypoint: 'codex' },
        location: { type: 'ssh', alias: 'gpu' },
        tmux: true,
      }),
    ).toEqual({
      defaults: { runtime: 'sbx', entrypoint: 'codex' },
      location: { type: 'ssh', alias: 'gpu' },
      tmux: true,
    })
  })
})

describe('runAgentWalkthrough', () => {
  beforeEach(() => {
    h.queue.length = 0
  })

  it('degrades to a raw manual local flow with no config', async () => {
    // engine(runtime, entrypoint), where, tmux, sync
    h.queue.push('local', 'claude', 'local', false, '')
    expect(await runAgentWalkthrough('backend')).toEqual({
      engine: { source: 'manual', runtime: 'local', entrypoint: 'claude' },
    })
  })

  it('collects a raw remote flow with host and port', async () => {
    // engine(runtime, entrypoint), where, host, port, sync (no tmux prompt for SSH)
    h.queue.push('local', 'claude', 'ssh', 'me@box:/srv', '2222', 'main')
    const result = await runAgentWalkthrough('researcher')
    expect(result?.location).toEqual({ type: 'ssh', host: 'me@box', base: '/srv', port: 2222 })
    expect(result?.syncRef).toBe('main')
  })

  it('pins a profile over a chosen role', async () => {
    // role, engine(pin), where, tmux, sync
    h.queue.push('builder', 'codex-sbx', 'local', false, '')
    expect(await runAgentWalkthrough('builder', configAware)).toEqual({
      role: 'builder',
      engine: { source: 'profile', runtimeProfile: 'codex-sbx' },
    })
  })

  it('keeps the role engine when chosen', async () => {
    // role, engine(keep-role sentinel), where, tmux, sync
    h.queue.push('builder', '(keep-role)', 'local', false, '')
    expect(await runAgentWalkthrough('builder', configAware)).toEqual({
      role: 'builder',
      engine: { source: 'role' },
    })
  })

  it('picks a declared host alias as a reference', async () => {
    const hostsOnly: QuimbyConfig = { hosts: { gpu: { host: 'me@gpu' } } }
    // engine(runtime, entrypoint), where=ssh, alias, sync
    h.queue.push('local', 'claude', 'ssh', 'gpu', 'main')
    const result = await runAgentWalkthrough('researcher', hostsOnly)
    expect(result?.location).toEqual({ type: 'ssh', alias: 'gpu' })
  })

  it('returns null when the user cancels', async () => {
    h.queue.push('local', 'claude', h.CANCEL)
    expect(await runAgentWalkthrough('backend')).toBeNull()
  })
})
