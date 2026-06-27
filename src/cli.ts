import { defineCommand, runCommand, showUsage } from 'citty'
import { logger } from './utils/logger.js'

const main = defineCommand({
  meta: {
    name: 'quimby',
    version: '0.2.0',
    description: 'Orchestrate multiple AI agents in isolated workers',
  },
  subCommands: {
    add: () => import('./commands/add.js').then((m) => m.default),
    run: () => import('./commands/run.js').then((m) => m.default),
    list: () => import('./commands/list.js').then((m) => m.default),
    status: () => import('./commands/status.js').then((m) => m.default),
    assign: () => import('./commands/assign.js').then((m) => m.default),
    diff: () => import('./commands/diff.js').then((m) => m.default),
    pack: () => import('./commands/pack.js').then((m) => m.default),
    apply: () => import('./commands/apply.js').then((m) => m.default),
    send: () => import('./commands/send.js').then((m) => m.default),
    reset: () => import('./commands/reset.js').then((m) => m.default),
    rename: () => import('./commands/rename.js').then((m) => m.default),
    remove: () => import('./commands/remove.js').then((m) => m.default),
    serve: () => import('./commands/serve.js').then((m) => m.default),
    subscribe: () => import('./commands/subscribe.js').then((m) => m.default),
    unsubscribe: () => import('./commands/unsubscribe.js').then((m) => m.default),
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
    console.log('0.2.0')
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
