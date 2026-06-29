import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildSSHLocation, runWorkerWalkthrough } from './walkthrough'

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

describe('buildSSHLocation', () => {
  it('parses a bare user@host', () => {
    expect(buildSSHLocation('me@box')).toEqual({ type: 'ssh', host: 'me@box' })
  })

  it('splits a remote base path on :/', () => {
    expect(buildSSHLocation('me@box:/srv/work')).toEqual({
      type: 'ssh',
      host: 'me@box',
      base: '/srv/work',
    })
  })

  it('includes the port when provided', () => {
    expect(buildSSHLocation('me@box', 2222)).toEqual({ type: 'ssh', host: 'me@box', port: 2222 })
  })
})

describe('runWorkerWalkthrough', () => {
  beforeEach(() => {
    h.queue.length = 0
  })

  it('collects a local worker configuration', async () => {
    // runtime, agent, where, tmux, syncRef, check
    h.queue.push('local', 'claude', 'local', false, '', 'npm test')
    const config = await runWorkerWalkthrough('backend')
    expect(config).toEqual({
      runtime: 'local',
      agent: 'claude',
      location: undefined,
      check: 'npm test',
    })
  })

  it('opts a local worker into tmux when confirmed', async () => {
    h.queue.push('local', 'claude', 'local', true, '', '')
    const config = await runWorkerWalkthrough('backend')
    expect(config?.tmux).toBe(true)
  })

  it('collects a remote worker configuration with host and port', async () => {
    // runtime, agent, where, host, port, syncRef, check (no tmux prompt for SSH)
    h.queue.push('local', 'claude', 'ssh', 'me@box:/srv', '2222', 'main', '')
    const config = await runWorkerWalkthrough('researcher')
    expect(config?.location).toEqual({ type: 'ssh', host: 'me@box', base: '/srv', port: 2222 })
    expect(config?.syncRef).toBe('main')
  })

  it('returns null when the user cancels', async () => {
    h.queue.push(h.CANCEL)
    expect(await runWorkerWalkthrough('backend')).toBeNull()
  })
})
