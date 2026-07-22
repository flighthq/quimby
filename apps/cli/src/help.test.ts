import { defineCommand } from 'citty'
import { describe, expect, it } from 'vitest'

import { renderRootHelp } from './help'

const subCommands = {
  add: defineCommand({ meta: { name: 'add', description: 'Create a new agent' } }),
  serve: () =>
    Promise.resolve(defineCommand({ meta: { name: 'serve', description: 'Start the server' } })),
}

describe('renderRootHelp', () => {
  it('renders curated group titles', async () => {
    const help = await renderRootHelp('desc', '9.9.9', subCommands)
    expect(help).toContain('Manage Agents')
    expect(help).toContain('Run & Inspect')
    expect(help).toContain('Move Work')
    expect(help).toContain('Server')
  })

  it('groups every registered command, including host, restart, and log', async () => {
    const help = await renderRootHelp('desc', '9.9.9', subCommands)
    // These are registered subcommands that were previously absent from the curated groups,
    // so a bare `quimby help` never listed them (a real "not listed by help" gap).
    expect(help).toContain('host')
    expect(help).toContain('restart')
    expect(help).toContain('log')
  })

  it('resolves each command description from its meta, including lazy loaders', async () => {
    const help = await renderRootHelp('desc', '9.9.9', subCommands)
    expect(help).toContain('Create a new agent')
    expect(help).toContain('Start the server')
  })

  it('lists the intercepted help verb', async () => {
    const help = await renderRootHelp('desc', '9.9.9', subCommands)
    expect(help).toContain('Show help for quimby or a specific command')
  })
})
