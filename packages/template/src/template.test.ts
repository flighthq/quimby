import { describe, expect, it } from 'vitest'

import { renderAgentClaudeMd } from './template'

describe('renderAgentClaudeMd', () => {
  it('includes the agent name', () => {
    const output = renderAgentClaudeMd({ agentName: 'alice', agentId: 'agent-id-123' })
    expect(output).toContain('alice')
  })

  it('includes the agent id', () => {
    const output = renderAgentClaudeMd({ agentName: 'alice', agentId: 'agent-id-123' })
    expect(output).toContain('agent-id-123')
  })

  it('references repo/CLAUDE.md', () => {
    const output = renderAgentClaudeMd({ agentName: 'alice', agentId: 'agent-id-123' })
    expect(output).toContain('@repo/CLAUDE.md')
  })

  it('includes assignment section', () => {
    const output = renderAgentClaudeMd({ agentName: 'alice', agentId: 'agent-id-123' })
    expect(output).toContain('assignment.md')
  })

  it('includes status section', () => {
    const output = renderAgentClaudeMd({ agentName: 'alice', agentId: 'agent-id-123' })
    expect(output).toContain('status.md')
  })

  it('includes inbox section', () => {
    const output = renderAgentClaudeMd({ agentName: 'alice', agentId: 'agent-id-123' })
    expect(output).toContain('inbox/')
  })

  it('mentions the repo/ directory', () => {
    const output = renderAgentClaudeMd({ agentName: 'alice', agentId: 'agent-id-123' })
    expect(output).toContain('repo/')
  })

  it('uses the agent name in the header', () => {
    const output = renderAgentClaudeMd({ agentName: 'my-agent', agentId: 'agent-id-123' })
    expect(output).toContain('**my-agent**')
  })

  it('ends with a newline', () => {
    const output = renderAgentClaudeMd({ agentName: 'alice', agentId: 'agent-id-123' })
    expect(output.endsWith('\n')).toBe(true)
  })
})
