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
      'set -g status-right "#[fg=colour245] %a %b %d  %H:%M "',
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
    ].join('\n') + '\n'
  )
}

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
    `1. **Read your assignment**: Check \`assignment.md\` for your task`,
    `2. **Work in repo/**: Make changes and commit to the repo as you go`,
    `3. **Update your status**: Write progress to \`status.md\` periodically`,
    `4. **Commit against the baseline**: All your commits are measured against the \`quimby/seed\` tag`,
    ``,
    `## Status Updates`,
    ``,
    `Keep \`status.md\` current. Write a brief summary of:`,
    `- What you're working on`,
    `- Any blockers or questions`,
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
    `## Project Instructions`,
    ``,
    `@repo/CLAUDE.md`,
  ]

  return sections.join('\n') + '\n'
}
