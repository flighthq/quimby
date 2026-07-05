import { QUIMBY_CONTEXT } from './quimbyContext'

/**
 * The tmux config Quimby runs its own isolated server with (`tmux -L quimby -f …`),
 * so the agent UX is good without depending on the user's `~/.tmux.conf`. Layered:
 *
 *  1. Calm aesthetic defaults (a muted status bar showing the agent/window name — no
 *     default bright-green bar). These are *overridable*.
 *  2. The user's own `~/.tmux.conf`, sourced if present, so their keybindings and
 *     theme still apply on Quimby's sessions.
 *  3. Quimby's functional must-haves, set *last* so they win: true-color passthrough,
 *     mouse (scroll wheel reaches scrollback), a generous history limit, and stable
 *     window names (so the per-run `rename-window` to the agent name sticks).
 *
 * Colour codes use the 256-palette so they render on any terminal; the must-haves
 * still enable 24-bit colour for the agent program itself.
 */
export function renderTmuxConfig(): string {
  return (
    [
      '# Quimby-managed tmux config (isolated server: tmux -L quimby).',
      '# Layered: calm defaults → your ~/.tmux.conf (if any) → Quimby must-haves.',
      '',
      '# ── Calm defaults (overridden by your own config if you have one) ──',
      'set -g status on',
      'set -g status-position bottom',
      'set -g status-justify left',
      'set -g status-interval 5',
      'set -g status-style "bg=colour235,fg=colour250"',
      'set -g status-left-length 40',
      'set -g status-left "#[fg=colour109,bold] quimby #[default]"',
      'set -g status-right-length 60',
      // Surface the detach key rather than the date: "^b d" leaves the agent running and
      // returns you to your shell — the intended way to step away (the session is durable;
      // only `quimby stop` tears it down). The dashboard overrides this with its own hint.
      'set -g status-right "#[fg=colour240]^b d detach — agent keeps running  #[fg=colour245]%H:%M "',
      // Each tab is " #W " — one space, the name, one space — and the styles wrap the whole
      // string, so a selected tab's background covers both spaces too. The separator is empty
      // so adjacent tabs share an edge with no standalone gap or bar between them.
      'set -g window-status-separator ""',
      'set -g window-status-format " #W "',
      'set -g window-status-style "fg=colour244"',
      'set -g window-status-current-format " #W "',
      'set -g window-status-current-style "fg=colour231,bg=colour238,bold"',
      'set -g message-style "bg=colour109,fg=colour235"',
      'set -g pane-border-style "fg=colour238"',
      'set -g pane-active-border-style "fg=colour109"',
      'set -g mode-keys vi',
      '',
      '# ── Your own config layers on top (keybindings, theme), if present ──',
      'source-file -q ~/.tmux.conf',
      '',
      '# ── Quimby must-haves (set last so they win; needed for the agent UX) ──',
      'set -g  default-terminal "tmux-256color"',
      'set -ga terminal-overrides ",*:Tc"',
      'set -g  mouse on',
      'set -g  history-limit 50000',
      'set -g  automatic-rename off',
      'set -g  allow-rename off',
      'set -g  bell-action none',
      'set -g  activity-action none',
      'set -g  silence-action none',
      'set -g  visual-bell off',
      'set -g  visual-activity off',
      'set -g  visual-silence off',
      'set -g  status-left "#[fg=colour109,bold] quimby #[default]"',
      'set -g  window-status-separator ""',
      // Never let tmux's default `reverse` alert style invert a tab background; the dashboard
      // signals activity/silence through the icon foreground instead.
      'set -g  window-status-activity-style none',
      'set -g  window-status-bell-style none',
      '# Keep prefix+c useful from agent panes: new windows start at the project root',
      '# recorded on the session, falling back to the current pane path for older sessions.',
      'bind c new-window -c "#{?@quimby-root,#{@quimby-root},#{pane_current_path}}"',
      '# Restart a dead agent pane without needing dashboard-specific bindings.',
      'bind r respawn-window -k',
      'bind R respawn-window -k',
      '',
      '# Copy to the system clipboard so selections leave the tmux pane. copy-command pipes',
      '# the selection straight to the OS clipboard binary, which works even inside the nested',
      "# panel dashboard where OSC 52 often can't traverse the layers; set-clipboard on is an",
      '# OSC 52 fallback. Drag-select or Ctrl+C-while-selecting copies; double/triple-click',
      "# selects word/line; right-click pastes; hold Shift for the terminal's own selection.",
      'set -g  set-clipboard on',
      "set -g  copy-command 'pbcopy 2>/dev/null || wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null || xsel -ib 2>/dev/null || clip.exe 2>/dev/null'",
      'bind -T copy-mode    MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel',
      'bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel',
      'bind -T copy-mode    C-c send-keys -X copy-pipe-and-cancel',
      'bind -T copy-mode-vi C-c send-keys -X copy-pipe-and-cancel',
      'bind -n MouseDown3Pane paste-buffer',
    ].join('\n') + '\n'
  )
}

/**
 * The one-line request quimby types into an agent (via `nudge --verify`) or appends to an
 * assignment (`assign --verify`), asking it to self-verify and record a `quimby-attest` block.
 * Names the agent's own `check` command when set, else a generic instruction. Kept single-line so
 * it types cleanly into a tmux prompt; the exact block format lives in the agent's CLAUDE.md.
 */
export function renderVerifyRequest(check?: string): string {
  const cmd = check ? `\`${check}\`` : "your project's tests/build"
  return (
    `Commit your work first, then run your verification (${cmd}) and record it with ` +
    `\`./agent.sh attest --command "..." --result pass|fail --summary "..."\`. Committing first ` +
    `is what makes atCommit match the tree that gets carried.`
  )
}

/**
 * The message quimby types into a freshly-launched agent that has a non-empty `status.md` from a
 * prior session — the recovery loop. Points it at its predecessor's status and active task context
 * so it resumes rather than starting cold.
 */
export function renderResumeRequest(): string {
  return (
    'continue\n\n' +
    'A previous session left status. Run `./agent.sh status`, then `./agent.sh assignment` and ' +
    '`./agent.sh inbox` before continuing.'
  )
}

/**
 * Substitute an agent's identity into the shared {@link QUIMBY_CONTEXT} block. This is the
 * Quimby tier both `CLAUDE.md` and `AGENTS.md` carry; the repo's own instructions are a second
 * tier the tools discover natively under `repo/`.
 */
export function renderQuimbyContext(opts: { agentName: string; agentId: string }): string {
  // agentId is still accepted (callers pass it) but no longer surfaced to the agent — its UUID is
  // plumbing it never uses, and leading with it read as framework-forward "you are a managed agent".
  return QUIMBY_CONTEXT.replaceAll('{{agentName}}', opts.agentName)
}

/**
 * The agent's `CLAUDE.md` (Claude Code's entrypoint): the Quimby context, then an `@repo/CLAUDE.md`
 * import. Claude Code reads `CLAUDE.md` and resolves `@`-imports, so the repo's own instructions
 * load directly; a missing target is silently skipped, so the line is safe whether or not the repo
 * has one.
 */
export function renderAgentClaudeMd(opts: { agentName: string; agentId: string }): string {
  return `${renderQuimbyContext(opts)}\n## Project instructions\n\n@repo/CLAUDE.md\n`
}

/**
 * The agent's `AGENTS.md` (Codex and other AGENTS.md readers): the Quimby context, then a plain
 * pointer at the repo tier. These tools read `AGENTS.md` as literal text with no `@`-import
 * mechanism, so the context is inlined (not linked) and the repo's own guidance is named in prose
 * rather than imported — the tool discovers `repo/AGENTS.md` natively as it works there.
 */
export function renderAgentAgentsMd(opts: { agentName: string; agentId: string }): string {
  return (
    `${renderQuimbyContext(opts)}\n## Project instructions\n\n` +
    'This project may provide its own guidance in `repo/AGENTS.md` (and `repo/CLAUDE.md`). Treat ' +
    'it as the project-specific layer on top of this Quimby context; follow it where it applies.\n'
  )
}
