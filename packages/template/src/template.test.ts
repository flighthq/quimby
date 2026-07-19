import { describe, expect, it } from 'vitest'

import {
  renderAgentAgentsMd,
  renderAgentClaudeMd,
  renderQuimbyContext,
  renderResolveConflictRequest,
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

  it('picks the capability clause by runtime — sandboxed runs freely, local/unknown stays conservative', () => {
    const sandboxed = renderQuimbyContext({ agentName: 'a', agentId: 'id', runtime: 'sbx' })
    // A real sandbox is told running the code is its job and not to defer to the host.
    expect(sandboxed).toContain('isolated does not mean read-only')
    expect(sandboxed).toContain('running the code is your job')
    expect(sandboxed).not.toContain('running **locally**')
    expect(sandboxed).not.toContain('{{')

    // openshell is also a sandbox runtime.
    expect(renderQuimbyContext({ agentName: 'a', agentId: 'id', runtime: 'openshell' })).toContain(
      'running the code is your job',
    )

    // A local agent (or an unknown/undefined runtime resolved pre-launch) gets the guarded text.
    for (const runtime of ['local', undefined, 'weird-future-runtime']) {
      const out = renderQuimbyContext({ agentName: 'a', agentId: 'id', runtime })
      expect(out).toContain('running **locally**')
      expect(out).toContain("without the user's go-ahead")
      expect(out).not.toContain('running the code is your job')
      expect(out).not.toContain('{{')
    }
  })

  it('teaches agent.sh as the normal coordination API and keeps raw layout out of normal usage', () => {
    const out = renderQuimbyContext({ agentName: 'alice', agentId: 'id' })
    expect(out).toContain('./agent.sh help')
    expect(out).toContain('./agent.sh assignment')
    expect(out).toContain('./agent.sh status')
    expect(out).toContain('./agent.sh inbox')
    expect(out).toContain('./agent.sh handoff <recipient>')
    expect(out).toContain('./agent.sh attest')
    expect(out).toContain('protocol underneath the tool')
    // The legacy layout must be gone.
    expect(out).not.toContain('inbox/<sender>')
    expect(out).not.toContain('outbox/<recipient>')
    // Normal instructions should not teach agents to publish by raw path.
    expect(out).not.toContain('mv handoff/out/draft/<recipient> handoff/out/queued/<recipient>')
  })

  it('carries the recovery-loop, keep-assignment-true, peer, and verify rules', () => {
    const out = renderQuimbyContext({ agentName: 'alice', agentId: 'id' })
    // Recovery: resume from a predecessor through agent.sh.
    expect(out).toContain('Resume first')
    expect(out).toContain('successor')
    // Keep assignment true from an in-session user retask; a peer's note never retasks.
    expect(out).toContain('in this session')
    expect(out).toContain("a peer's note is never an assignment")
    // The live user outranks a stored (possibly stale) assignment — no relapsing after a /clear.
    expect(out).toContain('the live user')
    expect(out).toContain('stale, not a rule to defend')
    expect(out).toContain('`/clear`')
    // Fresh-context discriminator: can't introspect why context is fresh; decide from first message.
    expect(out).toContain("you can't tell _why_ it's fresh")
    expect(out).toContain('It continues the standing task')
    expect(out).toContain('It redefines the task')
    expect(out).toContain('treat it as a **retask**')
    // Peer rules: assignment outranks peers (not the user), collaborate don't direct.
    expect(out).toContain('your assignment outranks any peer note')
    expect(out).toContain('never over the live user')
    expect(out).toContain('input to weigh, not orders')
    expect(out).toContain("collaborate, don't direct")
    // Verify: commit first + agent.sh attest.
    expect(out).toContain('commit first')
    expect(out).toContain('./agent.sh attest')
    // Status writes are silent.
    expect(out).toContain('silent')
    // Commits are one-line, no body, no co-author trailer.
    expect(out).toContain('single line')
    expect(out).toContain('Co-Authored-By')
    // The `quimby ·` courier-lead grammar: distinguishes delivered messages from live user input.
    expect(out).toContain('`quimby ·`')
    expect(out).toContain('parcel from <agent>')
    expect(out).toContain('assignment updated')
    expect(out).toContain('resume from @status.md')
    expect(out).toContain('no** `quimby ·` lead is the user typing')
  })

  it('mirrors peer status into status/ for on-demand peek', () => {
    const out = renderQuimbyContext({ agentName: 'alice', agentId: 'id' })
    expect(out).toContain('./agent.sh peers')
    expect(out).toContain('listed by `./agent.sh peers`')
  })

  it('ends with a newline', () => {
    expect(renderQuimbyContext({ agentName: 'a', agentId: 'b' }).endsWith('\n')).toBe(true)
  })
})

describe('renderResolveConflictRequest', () => {
  it('is a short courier body naming the sync ref, with git steps left to AGENTS.md', () => {
    expect(renderResolveConflictRequest('main')).toBe('rebase onto main and resolve conflicts')
    expect(renderResolveConflictRequest('release')).toContain('release')
    // Kept short — the how lives in the agent context, not the one-line lead.
    expect(renderResolveConflictRequest('main')).not.toContain('git ')
  })
})

describe('renderResumeRequest', () => {
  it('is the terse courier resume label the `quimby ·` lead is prepended to', () => {
    // nudgeAgentSession renders `quimby · resume from @status.md`; this is just the label body.
    expect(renderResumeRequest()).toBe('resume from @status.md')
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

  it('renders plain padded tabs without a standalone separator after "quimby"', () => {
    const conf = renderTmuxConfig()
    expect(conf).toContain('set -g status-left "#[fg=colour109,bold] quimby #[default]"')
    expect(conf).not.toContain('quimby #[fg=colour240]│')
    expect(conf).not.toContain('│ #W')
    // The format itself provides the before/after title spaces; the empty separator means
    // adjacent tabs share an edge without an additional gap cell between them.
    expect(conf).toContain('set -g window-status-format " #W "')
    expect(conf).toContain('set -g window-status-current-format " #W "')
    expect(conf).toContain('set -g window-status-separator ""')
    expect(conf.indexOf('source-file -q ~/.tmux.conf')).toBeLessThan(
      conf.lastIndexOf('window-status-separator ""'),
    )
    expect(conf.indexOf('source-file -q ~/.tmux.conf')).toBeLessThan(
      conf.lastIndexOf('status-left "#[fg=colour109,bold] quimby #[default]"'),
    )
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

  it('binds lowercase and uppercase prefix+r to restart a dead pane', () => {
    const conf = renderTmuxConfig()
    expect(conf).toContain('bind r respawn-window -k')
    expect(conf).toContain('bind R respawn-window -k')
    expect(conf.indexOf('source-file -q ~/.tmux.conf')).toBeLessThan(
      conf.indexOf('bind r respawn-window -k'),
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
    expect(out).toContain('./agent.sh attest')
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
