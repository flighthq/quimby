import type { CommandMeta } from 'citty'
import { describe, expect, it, vi } from 'vitest'

// Mock citty's runCommand to prevent actual CLI execution on import
vi.mock('citty', async (importOriginal) => {
  const m = await importOriginal()
  return { ...(m as object), runCommand: vi.fn().mockResolvedValue(undefined) }
})

describe('cli', () => {
  it('command modules export citty command objects with subcommands', async () => {
    // Each command module has a default export with meta and run
    const add = await import('./commands/add')
    expect(add.default).toBeDefined()
    expect((add.default.meta as CommandMeta)?.name).toBe('add')

    const run = await import('./commands/run')
    expect(run.default).toBeDefined()
    expect((run.default.meta as CommandMeta)?.name).toBe('run')

    const list = await import('./commands/list')
    expect(list.default).toBeDefined()
    expect((list.default.meta as CommandMeta)?.name).toBe('list')
  })

  it('all subcommands have a name in meta', async () => {
    const commands = [
      'add',
      'assign',
      'doctor',
      'diff',
      'dispatch',
      'handoff',
      'list',
      'rebuild',
      'remove',
      'rename',
      'restore',
      'run',
      'serve',
      'set',
      'storage',
      'up',
      'status',
      'sync',
    ]
    for (const name of commands) {
      const mod = await import(`./commands/${name}`)
      expect(mod.default, `${name} command`).toBeDefined()
      expect((mod.default.meta as CommandMeta)?.name, `${name} meta.name`).toBe(name)
    }
  })
})
