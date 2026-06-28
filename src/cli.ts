import { defineCommand, runCommand, showUsage } from 'citty'

import { logger } from './utils/logger'

const main = defineCommand({
  meta: {
    name: 'quimby',
    version: '0.2.0',
    description: 'Orchestrate multiple AI agents in isolated workers',
  },
  subCommands: {
    add: () => import('./commands/add').then((m) => m.default),
    run: () => import('./commands/run').then((m) => m.default),
    list: () => import('./commands/list').then((m) => m.default),
    status: () => import('./commands/status').then((m) => m.default),
    assign: () => import('./commands/assign').then((m) => m.default),
    flush: () => import('./commands/flush').then((m) => m.default),
    diff: () => import('./commands/diff').then((m) => m.default),
    pack: () => import('./commands/pack').then((m) => m.default),
    apply: () => import('./commands/apply').then((m) => m.default),
    send: () => import('./commands/send').then((m) => m.default),
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
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    const [cmd, parent] = await resolveDeepest(main, rawArgs)
    await showUsage(cmd, parent)
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
