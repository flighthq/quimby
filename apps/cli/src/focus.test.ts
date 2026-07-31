import type { QuimbyState } from '@quimbyhq/types'
import type * as WorkspaceModule from '@quimbyhq/workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'

const loadQuimbyConfig = vi.hoisted(() => vi.fn(async () => ({}) as Record<string, unknown>))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceModule>()),
  loadQuimbyConfig,
}))

afterEach(() => vi.clearAllMocks())

const state = {
  agents: {
    principal: { id: 'p', name: 'principal', directs: ['manager'] },
    manager: { id: 'm', name: 'manager', directs: ['builder'] },
    builder: { id: 'b', name: 'builder' },
  },
} as unknown as QuimbyState

describe('resolveNudgeFocusOptions', () => {
  it('derives hold for the agent nobody directs and nudge for the rest — "all but the one I talk to"', async () => {
    const { resolveNudgeFocusOptions } = await import('./focus')
    expect((await resolveNudgeFocusOptions('/repo', state, 'principal')).whenFocused).toBe('hold')
    expect((await resolveNudgeFocusOptions('/repo', state, 'manager')).whenFocused).toBe('nudge')
    expect((await resolveNudgeFocusOptions('/repo', state, 'builder')).whenFocused).toBe('nudge')
  })

  it('lets an explicit workspace policy override the derived default', async () => {
    loadQuimbyConfig.mockResolvedValue({ whenFocused: 'nudge' })
    const { resolveNudgeFocusOptions } = await import('./focus')
    expect((await resolveNudgeFocusOptions('/repo', state, 'principal')).whenFocused).toBe('nudge')
  })

  it('carries the configured focus grace alongside the policy, from one config read', async () => {
    loadQuimbyConfig.mockResolvedValue({ focusGrace: '90s' })
    const { resolveNudgeFocusOptions } = await import('./focus')
    const opts = await resolveNudgeFocusOptions('/repo', state, 'builder')
    expect(opts.focusGraceSeconds).toBe(90)
    expect(loadQuimbyConfig).toHaveBeenCalledTimes(1)
  })
})
