export function renderWorkerClaudeMd(opts: {
  workerName: string
}): string {
  const { workerName } = opts

  const sections = [
    `# Agent Instructions`,
    ``,
    `You are the **${workerName}** worker.`,
    ``,
    `## Workspace Layout`,
    ``,
    `Key paths relative to your worker root:`,
    ``,
    `- \`repo/\` — the source code repository (your main workspace)`,
    `- \`assignment.md\` — your current task (read this first)`,
    `- \`status.md\` — write your current status here`,
    `- \`inbox/\` — packs and status updates from other workers`,
    `  - \`inbox/<pack-name>/\` — a pack (contains \`meta.yaml\` and \`squashed.diff\`)`,
    `  - \`inbox/status/<worker-name>.md\` — latest status from another worker`,
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
    `## Incoming Work`,
    ``,
    `Check \`inbox/\` for packs and status updates from other workers.`,
    `- Packs in \`inbox/<name>/\` contain a \`meta.yaml\` and \`squashed.diff\``,
    `- Status updates in \`inbox/status/<worker>.md\` show other workers' progress`,
    ``,
    `## Project Instructions`,
    ``,
    `@repo/CLAUDE.md`,
  ]

  return sections.join('\n') + '\n'
}
