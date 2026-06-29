import { logger } from '@quimbyhq/utils'
import type { SubCommandsDef } from 'citty'
import { defineCommand, runCommand, showUsage } from 'citty'

import { renderRootHelp } from './help'

const main = defineCommand({
  meta: {
    name: 'quimby',
    version: '0.2.0',
    description: 'Dispatch AI agents, review their work, apply what works',
  },
  subCommands: {
    add: () => import('./commands/add').then((m) => m.default),
    config: () => import('./commands/config').then((m) => m.default),
    run: () => import('./commands/run').then((m) => m.default),
    list: () => import('./commands/list').then((m) => m.default),
    status: () => import('./commands/status').then((m) => m.default),
    assign: () => import('./commands/assign').then((m) => m.default),
    diff: () => import('./commands/diff').then((m) => m.default),
    handoff: () => import('./commands/handoff').then((m) => m.default),
    dispatch: () => import('./commands/dispatch').then((m) => m.default),
    apply: () => import('./commands/apply').then((m) => m.default),
    set: () => import('./commands/set').then((m) => m.default),
    sync: () => import('./commands/sync').then((m) => m.default),
    advance: () => import('./commands/advance').then((m) => m.default),
    reset: () => import('./commands/reset').then((m) => m.default),
    rename: () => import('./commands/rename').then((m) => m.default),
    remove: () => import('./commands/remove').then((m) => m.default),
    serve: () => import('./commands/serve').then((m) => m.default),
    subscribe: () => import('./commands/subscribe').then((m) => m.default),
    unsubscribe: () => import('./commands/unsubscribe').then((m) => m.default),
  },
})

const rawArgs = process.argv.slice(2)

async function resolveDeepest(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cmd: any,
  args: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parent?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<[any, any]> {
  const subs = typeof cmd.subCommands === 'function' ? await cmd.subCommands() : cmd.subCommands
  if (subs) {
    const name = args.find((a) => !a.startsWith('-'))
    if (name && subs[name]) {
      const sub = typeof subs[name] === 'function' ? await subs[name]() : subs[name]
      return resolveDeepest(sub, args.slice(args.indexOf(name) + 1), cmd)
    }
  }
  return [cmd, parent]
}

async function run() {
  // `help` is intercepted here rather than registered as a subcommand so it can
  // introspect its siblings; `quimby help <cmd>` mirrors `quimby <cmd> --help`.
  const isHelpVerb = rawArgs[0] === 'help'
  const wantsHelp = isHelpVerb || rawArgs.includes('--help') || rawArgs.includes('-h')
  if (wantsHelp || rawArgs.length === 0) {
    const helpArgs = isHelpVerb ? rawArgs.slice(1) : rawArgs
    const [cmd, parent] = await resolveDeepest(main, helpArgs)
    if (cmd === main) {
      // Root help: our grouped renderer + wordmark, not citty's flat list.
      const { description = '', version = '' } = main.meta as {
        description?: string
        version?: string
      }
      const subCommands = (main.subCommands ?? {}) as SubCommandsDef
      console.log(await renderRootHelp(description, version, subCommands)) // eslint-disable-line no-console
    } else {
      await showUsage(cmd, parent)
    }
    process.exit(0)
  }
  if (rawArgs.length === 1 && rawArgs[0] === '--version') {
    console.log('0.2.0') // eslint-disable-line no-console
    process.exit(0)
  }
  try {
    await runCommand(main, { rawArgs })
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

run()
