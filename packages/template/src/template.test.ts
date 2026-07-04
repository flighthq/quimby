import { describe, expect, it } from 'vitest'

import {
  renderAgentAgentsMd,
  renderAgentClaudeMd,
  renderQuimbyContext,
  renderResumeRequest,
  renderTmuxConfig,
  renderVerifyRequest,
} from './template'

describe('renderAgentAgentsMd', () => {
  it('inlines the Quimby context (no @-import) and points at the repo tier in prose', () => {
    const out = renderAgentAgentsMd({ agentName: 'alice', agentId: 'id' })
    // AGENTS.md carries the context inline — Codex reads it as literal text.
    expect(out).toContain('one of several agents')
    expect(out).toContain('**alice**')
    // The repo tier is named, not @-imported (imports are inert in AGENTS.md).
    expect(out).toContain('repo/AGENTS.md')
    expect(out).toContain('project-specific layer')
    expect(out).not.toContain('@repo/')
    expect(out).not.toContain('@CLAUDE.md')
    expect(out.endsWith('\n')).toBe(true)
  })
})

describe('renderAgentClaudeMd', () => {
  it('carries the Quimby context and @-imports the repo CLAUDE.md tier', () => {
    const out = renderAgentClaudeMd({ agentName: 'alice', agentId: 'agent-id-123' })
    expect(out).toContain('one of several agents')
    expect(out).toContain('**alice**')
    // Claude Code resolves @-imports, so the repo's own instructions load directly.
    expect(out).toContain('@repo/CLAUDE.md')
    expect(out.endsWith('\n')).toBe(true)
  })
})

describe('renderQuimbyContext', () => {
  it('substitutes the agent name work-first, leaks no tokens, and omits framework identity', () => {
    const out = renderQuimbyContext({ agentName: 'my-agent', agentId: 'agent-id-123' })
    expect(out).toContain('**my-agent**')
    expect(out).not.toContain('{{')
    // The agent no longer wears a framework meta-identity or its plumbing UUID.
    expect(out).not.toContain('# Quimby Agent')
    expect(out).not.toContain('agent-id-123')
  })

  it('teaches the handoff mailbox tree and the atomic author-then-publish move', () => {
    const out = renderQuimbyContext({ agentName: 'alice', agentId: 'id' })
    expect(out).toContain('in/received/<sender>-<hash>/')
    expect(out).toContain('in/processed/')
    expect(out).toContain('out/draft/<recipient>/')
    expect(out).toContain('out/queued/<recipient>/')
    expect(out).toContain('mv handoff/out/draft/<recipient> handoff/out/queued/<recipient>')
    expect(out).toContain('atomic')
    // The legacy layout must be gone.
    expect(out).not.toContain('inbox/<sender>')
    expect(out).not.toContain('outbox/<recipient>')
  })

  it('carries the recovery-loop, keep-assignment-true, peer, and verify rules', () => {
    const out = renderQuimbyContext({ agentName: 'alice', agentId: 'id' })
    // Recovery: resume from a predecessor; a successor resumes from status.md alone.
    expect(out).toContain('Resume first')
    expect(out).toContain('successor')
    // Keep assignment.md true from an in-session user retask; a peer's note never retasks.
    expect(out).toContain('in this session')
    expect(out).toContain("a peer's note is never an assignment")
    // Peer rules: assignment is authority, collaborate don't direct.
    expect(out).toContain('your assignment is your authority')
    expect(out).toContain('input to weigh, not orders')
    expect(out).toContain("collaborate, don't direct")
    // Verify: commit first + the exact attest block.
    expect(out).toContain('commit first')
    expect(out).toContain('```quimby-attest')
    expect(out).toContain('result: pass')
    // Status writes are silent.
    expect(out).toContain('silent')
  })

  it('mirrors peer status into status/ for on-demand peek', () => {
    const out = renderQuimbyContext({ agentName: 'alice', agentId: 'id' })
    expect(out).toContain('status/<peer>.md')
    expect(out).toContain('ls status/')
  })

  it('ends with a newline', () => {
    expect(renderQuimbyContext({ agentName: 'a', agentId: 'b' }).endsWith('\n')).toBe(true)
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

  it('opens prefix+c windows from the recorded project root when available', () => {
    const conf = renderTmuxConfig()
    expect(conf).toContain(
      'bind c new-window -c "#{?@quimby-root,#{@quimby-root},#{pane_current_path}}"',
    )
    expect(conf.indexOf('source-file -q ~/.tmux.conf')).toBeLessThan(
      conf.indexOf('bind c new-window'),
    )
  })

  it('suppresses tmux alert sounds and visual popups after the user config is sourced', () => {
    const conf = renderTmuxConfig()
    expect(conf).toContain('bell-action none')
    expect(conf).toContain('activity-action none')
    expect(conf).toContain('silence-action none')
    expect(conf).toContain('visual-bell off')
    expect(conf).toContain('visual-activity off')
    expect(conf).toContain('visual-silence off')
    expect(conf.indexOf('source-file -q ~/.tmux.conf')).toBeLessThan(
      conf.indexOf('bell-action none'),
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
