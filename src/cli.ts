import { defineCommand, runMain } from 'citty'

const aliases: Record<string, string[]> = {
  add: ['sandbox', 'add'],
  list: ['sandbox', 'list'],
  start: ['sandbox', 'start'],
  stop: ['sandbox', 'stop'],
  assign: ['sandbox', 'assign'],
  status: ['sandbox', 'status'],
  refresh: ['sandbox', 'refresh'],
  review: ['bundle', 'review'],
  apply: ['bundle', 'apply'],
  send: ['bundle', 'send'],
}

function expandAliases(argv: string[]): string[] {
  const rawArgs = argv.slice(2)
  const first = rawArgs[0]
  if (first && first in aliases) {
    return [...aliases[first], ...rawArgs.slice(1)]
  }
  return rawArgs
}

const main = defineCommand({
  meta: {
    name: 'ao',
    version: '0.1.0',
    description: 'Agent Orchestrator — manage isolated agent sandboxes',
  },
  subCommands: {
    init: () => import('./commands/init.js').then((m) => m.default),
    sandbox: () => import('./commands/sandbox/index.js').then((m) => m.default),
    bundle: () => import('./commands/bundle/index.js').then((m) => m.default),
    watch: () => import('./commands/watch.js').then((m) => m.default),
    workspace: () => import('./commands/workspace/index.js').then((m) => m.default),
  },
})

runMain(main, { rawArgs: expandAliases(process.argv) })
