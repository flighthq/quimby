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
  { title: 'Manage Agents', names: ['add', 'config', 'set', 'rename', 'remove', 'rebuild'] },
  { title: 'Run & Inspect', names: ['run', 'list', 'status', 'diff', 'sync'] },
  { title: 'Move Work', names: ['assign', 'nudge', 'handoff', 'dispatch', 'merge'] },
  { title: 'Server', names: ['serve', 'subscribe', 'unsubscribe'] },
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

  for (const { title, names } of COMMAND_GROUPS) {
    // Pad to the group's own longest name, not the global maximum, so a long
    // outlier (`unsubscribe`) only widens its own group instead of every row.
    const width = Math.max(...names.map((name) => name.length))
    lines.push(colors.bold(colors.cyan(title)))
    lines.push('')
    for (const name of names) {
      lines.push(`  ${colors.bold(name.padEnd(width))}  ${descriptions.get(name) ?? ''}`)
    }
    lines.push('')
  }

  lines.push(colors.dim('Run `quimby help <command>` for details on a command.'))
  return lines.join('\n')
}

async function resolveDescription(loader: CommandLoader | undefined): Promise<string> {
  if (!loader) return ''
  // citty entries are Resolvable: a CommandDef, a Promise of one, or a thunk
  // returning either. The same shape applies to the command's own meta.
  const command = await (typeof loader === 'function' ? loader() : loader)
  const meta = await (typeof command.meta === 'function' ? command.meta() : command.meta)
  return meta?.description ?? ''
}
