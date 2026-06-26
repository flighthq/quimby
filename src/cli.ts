import { defineCommand, runMain } from 'citty'

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

runMain(main)
