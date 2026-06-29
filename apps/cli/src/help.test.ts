import { defineCommand } from 'citty'
import { describe, expect, it } from 'vitest'

import { renderRootHelp } from './help'

const subCommands = {
  add: defineCommand({ meta: { name: 'add', description: 'Create a new worker' } }),
  serve: () =>
    Promise.resolve(defineCommand({ meta: { name: 'serve', description: 'Start the server' } })),
}

describe('renderRootHelp', () => {
  it('renders curated group titles', async () => {
    const help = await renderRootHelp('desc', '9.9.9', subCommands)
    expect(help).toContain('Workers')
    expect(help).toContain('Packs & assignments')
    expect(help).toContain('Server')
  })

  it('resolves each command description from its meta, including lazy loaders', async () => {
    const help = await renderRootHelp('desc', '9.9.9', subCommands)
    expect(help).toContain('Create a new worker')
    expect(help).toContain('Start the server')
  })

  it('lists the intercepted help verb', async () => {
    const help = await renderRootHelp('desc', '9.9.9', subCommands)
    expect(help).toContain('Show help for quimby or a specific command')
  })
})
