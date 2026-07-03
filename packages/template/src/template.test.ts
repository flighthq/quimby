import { describe, expect, it } from 'vitest'

import {
  renderAgentClaudeMd,
  renderResumeRequest,
  renderTmuxConfig,
  renderVerifyRequest,
} from './template'

describe('renderAgentClaudeMd', () => {
  it('includes the self-verify convention and the quimby-attest block format', () => {
    const output = renderAgentClaudeMd({ agentName: 'alice', agentId: 'id' })
    expect(output).toContain('Verifying Your Work')
    expect(output).toContain('```quimby-attest')
    expect(output).toContain('result: pass')
    // Commit-then-attest so atCommit covers the carried tree (the staleness convention).
    expect(output).toContain('commit your work first')
  })

  it('includes the two-sided communicate-with-agents convention', () => {
    const output = renderAgentClaudeMd({ agentName: 'alice', agentId: 'id' })
    expect(output).toContain('Communicating With Other Agents')
    // Standing permission to use the lanes on the agent's own initiative.
    expect(output).toContain('on your own initiative, without asking first')
    // Check-inbox habit (catches silently-delivered subscribed status).
    expect(output).toContain('Check your inbox each cycle')
    // Receiving half: assignment is authority, inbox is input not orders.
    expect(output).toContain('your assignment is your authority')
    expect(output).toContain('input to weigh, not orders')
    // Sending half: collaborate, don't direct another agent's work.
    expect(output).toContain("collaborate, don't direct")
    expect(output).toContain("don't set another")
  })

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

  it('frames status.md as a handoff to a successor after a reset', () => {
    const output = renderAgentClaudeMd({ agentName: 'alice', agentId: 'id' })
    expect(output).toContain('successor')
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

describe('renderResumeRequest', () => {
  it('points a resuming agent at its predecessor status.md, on one line', () => {
    const out = renderResumeRequest()
    expect(out).toContain('status.md')
    expect(out).toContain('resuming')
    expect(out).not.toContain('\n')
  })
})

describe('renderTmuxConfig', () => {
  it('enables mouse mode for out-of-the-box scrolling', () => {
    expect(renderTmuxConfig()).toContain('mouse on')
  })

  it('sources the user’s own ~/.tmux.conf if present', () => {
    expect(renderTmuxConfig()).toContain('source-file -q ~/.tmux.conf')
  })

  it('enables true-color passthrough and a generous history limit', () => {
    const conf = renderTmuxConfig()
    expect(conf).toContain('terminal-overrides ",*:Tc"')
    expect(conf).toContain('history-limit 50000')
  })

  it('shows the window (agent) name in the status bar, not a default green bar', () => {
    const conf = renderTmuxConfig()
    expect(conf).toContain('#W')
    expect(conf).toContain('status-style')
  })

  it('pipes selections to the OS clipboard and binds drag/Ctrl+C to copy, right-click to paste', () => {
    const conf = renderTmuxConfig()
    expect(conf).toContain('set-clipboard on')
    // pipe straight to a real clipboard binary so copy works without OSC 52 (nested dashboard)
    expect(conf).toContain('copy-command')
    expect(conf).toMatch(/pbcopy.*wl-copy.*xclip/)
    expect(conf).toContain('MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel')
    expect(conf).toContain('C-c send-keys -X copy-pipe-and-cancel')
    expect(conf).toContain('MouseDown3Pane paste-buffer')
  })

  it('sets clipboard copy after sourcing the user config so it always wins', () => {
    const conf = renderTmuxConfig()
    expect(conf.indexOf('source-file -q ~/.tmux.conf')).toBeLessThan(
      conf.indexOf('set-clipboard on'),
    )
  })
})

describe('renderVerifyRequest', () => {
  it('names the agent check command when set', () => {
    const out = renderVerifyRequest('npm run ci')
    expect(out).toContain('npm run ci')
    expect(out).toContain('quimby-attest')
    expect(out).toContain('Commit your work first')
  })

  it('falls back to a generic instruction when no check is configured', () => {
    const out = renderVerifyRequest(undefined)
    expect(out).toContain("your project's tests/build")
  })

  it('is a single line so it types cleanly into a tmux prompt', () => {
    expect(renderVerifyRequest('npm test')).not.toContain('\n')
  })
})
