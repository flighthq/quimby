import { quimbyTmuxSocket, tmuxSessionName } from '@quimbyhq/paths'
import type { AgentState } from '@quimbyhq/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renameAgentWindow } from './renameWindow'

const execa = vi.hoisted(() => vi.fn())

vi.mock('execa', () => ({ execa }))

beforeEach(() => {
  execa.mockReset()
})

afterEach(() => {
  execa.mockReset()
})

const localNoTmux: AgentState = {
  id: 'a1',
  name: 'builder',
  location: { type: 'local' },
} as AgentState

const localWithTmux: AgentState = {
  id: 'a2',
  name: 'reviewer',
  location: { type: 'local' },
  tmux: true,
} as AgentState

describe('renameAgentWindow', () => {
  it('is a no-op for a local agent without tmux (no session to relabel)', async () => {
    expect(await renameAgentWindow(localNoTmux, 'newname')).toBe(false)
    expect(execa).not.toHaveBeenCalled()
  })

  it('renames the live window when the session exists', async () => {
    execa.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    expect(await renameAgentWindow(localWithTmux, 'newname')).toBe(true)
    const session = tmuxSessionName('a2')
    const rename = execa.mock.calls.find((c) => (c[1] as string[]).includes('rename-window'))
    expect(rename?.[1]).toEqual(['-L', quimbyTmuxSocket, 'rename-window', '-t', session, 'newname'])
  })

  it('returns false without renaming when the session is not running', async () => {
    // has-session throws (no quimby tmux server), so the rename never fires.
    execa.mockRejectedValue(new Error('no session'))
    expect(await renameAgentWindow(localWithTmux, 'newname')).toBe(false)
    expect(execa.mock.calls.some((c) => (c[1] as string[]).includes('rename-window'))).toBe(false)
  })
})
