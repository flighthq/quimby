import type { SubCommandsDef } from 'citty'
import { colors } from 'consola/utils'

import { getQuimbyBanner } from './banner'

type CommandLoader = SubCommandsDef[string]

interface CommandGroup {
  title: string
  names: string[]
}

// Curated grouping for the root help. Grouping is the only thing curated here;
// each command's one-liner is read from its own meta, so descriptions never drift.
const COMMAND_GROUPS: readonly CommandGroup[] = [
  {
    title: 'Manage Agents',
    names: ['init', 'add', 'up', 'config', 'set', 'host', 'rename', 'remove', 'rebuild'],
  },
  {
    title: 'Run & Inspect',
    names: [
      'run',
      'start',
      'stop',
      'restart',
      'layout',
      'list',
      'status',
      'log',
      'diff',
      'sync',
      'doctor',
    ],
  },
  {
    title: 'Move Work',
    names: ['assign', 'nudge', 'delegate', 'handoff', 'dispatch', 'merge', 'merge-mode'],
  },
  { title: 'Storage', names: ['restore', 'storage'] },
  { title: 'Server', names: ['serve'] },
  { title: 'Help', names: ['help'] },
]

// Descriptions for commands handled outside citty's subCommands (intercepted in
// the entry point), so they have no resolvable meta of their own.
const VIRTUAL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  help: 'Show help for quimby or a specific command',
}

export async function renderRootHelp(
  description: string,
  version: string,
  subCommands: Readonly<Record<string, CommandLoader>>,
): Promise<string> {
  const descriptions = new Map<string, string>()
  for (const { names } of COMMAND_GROUPS) {
    for (const name of names) {
      descriptions.set(
        name,
        VIRTUAL_DESCRIPTIONS[name] ?? (await resolveDescription(subCommands[name])),
      )
    }
  }

  const lines: string[] = [
    getQuimbyBanner(),
    '',
    `${description} ${colors.dim(`(quimby v${version})`)}`,
    '',
  ]

  // Wrap descriptions to the terminal (capped for readability) with a hanging indent aligned under
  // the description column, so a long one-liner stays legible and never breaks the two-column layout.
  const wrapWidth = Math.min(process.stdout.columns || 80, 100)

  for (const { title, names } of COMMAND_GROUPS) {
    // Pad to the group's own longest name, not the global maximum, so a long
    // outlier only widens its own group instead of every row.
    const width = Math.max(...names.map((name) => name.length))
    const indent = 2 + width + 2
    lines.push(colors.bold(colors.cyan(title)))
    lines.push('')
    for (const name of names) {
      const wrapped = wrapText(descriptions.get(name) ?? '', wrapWidth - indent)
      const head = `  ${colors.bold(name.padEnd(width))}  ${wrapped[0] ?? ''}`
      lines.push(head)
      for (const cont of wrapped.slice(1)) lines.push(`${' '.repeat(indent)}${cont}`)
    }
    lines.push('')
  }

  lines.push(colors.dim('Run `quimby help <command>` for details on a command.'))
  return lines.join('\n')
}

// Greedy word-wrap to `width` columns; a single word longer than `width` is left intact rather
// than split. Returns at least one line (empty string for empty input) so callers can index [0].
function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}

async function resolveDescription(loader: CommandLoader | undefined): Promise<string> {
  if (!loader) return ''
  // citty entries are Resolvable: a CommandDef, a Promise of one, or a thunk
  // returning either. The same shape applies to the command's own meta.
  const command = await (typeof loader === 'function' ? loader() : loader)
  const meta = await (typeof command.meta === 'function' ? command.meta() : command.meta)
  return meta?.description ?? ''
}
