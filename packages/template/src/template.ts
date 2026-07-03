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
      'set -g status-left "#[fg=colour109,bold] quimby #[fg=colour240]│ "',
      'set -g status-right-length 60',
      // Surface the detach key rather than the date: "^b d" leaves the agent running and
      // returns you to your shell — the intended way to step away (the session is durable;
      // only `quimby stop` tears it down). The dashboard overrides this with its own hint.
      'set -g status-right "#[fg=colour240]^b d detach — agent keeps running  #[fg=colour245]%H:%M "',
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
    `Run your verification (${cmd}), then append a \`quimby-attest\` fenced block to the end of ` +
    `status.md with: command, result (pass|fail), summary, and atCommit (your current short commit ` +
    `hash). See "Verifying Your Work" in your agent instructions for the exact format.`
  )
}

/**
 * The message quimby types into a freshly-launched agent that has a non-empty `status.md` from a
 * prior session — the recovery loop. Points it at its predecessor's handoff so it resumes rather
 * than starting cold. Single-line so it types cleanly into the tmux prompt.
 */
export function renderResumeRequest(): string {
  return (
    'You are resuming a session — a previous instance of you left a handoff in status.md. Read ' +
    '@status.md first and continue from where it left off (check assignment.md and inbox/ too).'
  )
}

// The canonical `quimby-attest` block shape — the contract between an agent (writes it) and
// quimby's parser (reads it). Shown in the generated CLAUDE.md so agents emit the exact format.
const ATTEST_BLOCK_EXAMPLE = [
  '    ```quimby-attest',
  '    command: npm run ci',
  '    result: pass        # pass | fail',
  '    summary: 78 files, 646 tests green',
  '    atCommit: <your current short commit hash>',
  '    ```',
].join('\n')

export function renderAgentClaudeMd(opts: { agentName: string; agentId: string }): string {
  const { agentName, agentId } = opts

  const sections = [
    `# Agent Instructions`,
    ``,
    `You are the **${agentName}** agent.`,
    `Your stable agent id is \`${agentId}\` — it never changes, even if you are renamed.`,
    ``,
    `## Workspace Layout`,
    ``,
    `Key paths relative to your agent root:`,
    ``,
    `- \`repo/\` — the source code repository (your main workspace)`,
    `- \`assignment.md\` — your current task (read this first)`,
    `- \`status.md\` — write your current status here`,
    `- \`inbox/\` — parcels and status delivered to you by other agents`,
    `  - \`inbox/<sender>-<hash>/\` — a delivered parcel (\`meta.yaml\` plus an optional \`README.md\` note and/or \`squashed.diff\`)`,
    `  - \`inbox/status/<agent-name>.md\` — latest status from another agent`,
    `  - \`inbox/.done/\` — parcels you have already processed`,
    `- \`outbox/\` — parcels you want delivered to other agents, addressed by recipient`,
    `  - \`outbox/<recipient>/\` — a parcel for that agent; put a \`README.md\` note and any files in it`,
    ``,
    `## How to Work`,
    ``,
    `1. **Resume if you have a predecessor**: If \`status.md\` is non-empty, a prior instance of you`,
    `   left it as a handoff — read it first and continue from where it left off (quimby will also`,
    `   point you at it on a fresh launch).`,
    `2. **Read your assignment**: Check \`assignment.md\` for your task`,
    `3. **Work in repo/**: Make changes and commit to the repo as you go`,
    `4. **Update your status**: Write progress to \`status.md\` periodically`,
    `5. **Commit against the baseline**: All your commits are measured against the \`quimby/seed\` tag`,
    ``,
    `## Status Updates`,
    ``,
    `\`status.md\` is your handoff to whoever picks up next — a peer reading your progress, and`,
    `**your own successor**: if you crash or your context is reset, a fresh instance of you starts`,
    `from \`status.md\` alone. Write it so that reader can continue without re-deriving what you know.`,
    ``,
    `Keep it current. Write a brief summary of:`,
    `- What you're working on, and what you've already done (with enough detail to resume)`,
    `- Any blockers, open questions, or decisions still pending`,
    `- Where you left off — the next concrete step`,
    `- When you're done, write "done" with a summary`,
    ``,
    `## Incoming Parcels`,
    ``,
    `Check \`inbox/\` for parcels and status from other agents.`,
    `A parcel in \`inbox/<sender>-<hash>/\` contains a \`meta.yaml\` manifest and may include a \`README.md\` and/or code (\`squashed.diff\`, \`commits/\`).`,
    `If there is a \`README.md\`, read it first — it carries context or instructions from the sender.`,
    `When you have processed a parcel, move it to \`inbox/.done/\`.`,
    `Status updates in \`inbox/status/<agent>.md\` show other agents' progress.`,
    ``,
    `## Handing Work to Other Agents`,
    ``,
    `To send a parcel to another agent, create \`outbox/<recipient>/\` and write a \`README.md\` note (and any files) into it.`,
    `Your committed work is attached automatically; to attach a different agent's diff, add YAML frontmatter to the note:`,
    ``,
    `    ---`,
    `    attach: builder`,
    `    ---`,
    `    Promote builder's work; one nit in auth.ts.`,
    ``,
    `The user runs \`quimby dispatch ${agentName}\` to deliver every queued parcel to its recipient.`,
    ``,
    `## Verifying Your Work`,
    ``,
    `After you finish an assignment (or whenever asked to verify), run your verification — the`,
    `command quimby recorded as your \`check\` (named in the request), or your project's tests/build`,
    `— and record the outcome by appending a fenced \`quimby-attest\` block to the end of \`status.md\`:`,
    ``,
    ATTEST_BLOCK_EXAMPLE,
    ``,
    `Quimby reads the **latest** such block and relays it at the boundary — it never runs the check`,
    `itself, and never blocks on the result (the human decides). Set \`atCommit\` to your current`,
    `commit so quimby can tell whether the attestation is stale (your work changed since you`,
    `verified). Report honestly: \`result: fail\` with a short reason is more useful than a false pass.`,
    ``,
    `## Project Instructions`,
    ``,
    `@repo/CLAUDE.md`,
  ]

  return sections.join('\n') + '\n'
}
