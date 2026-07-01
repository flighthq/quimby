import { describe, expect, it, vi } from 'vitest'

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => {
    throw new Error('No quimby workspace found')
  }),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./serve')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when workspace is missing', async () => {
    const { default: cmd } = await import('./serve')
    await expect(cmd.run!({ args: {} } as never)).rejects.toThrow()
  })

  it('auto-dispatches outboxes by default (--no-dispatch to skip)', async () => {
    const { default: cmd } = await import('./serve')
    const args = cmd.args as Record<string, { type: string; default?: boolean }>
    expect(args.dispatch).toMatchObject({ type: 'boolean', default: true })
  })

  it('exposes -i/-t for an interactive shell on top of the server', async () => {
    const { default: cmd } = await import('./serve')
    const args = cmd.args as Record<string, { type: string; alias?: string }>
    expect(args.interactive).toMatchObject({ type: 'boolean', alias: 'i' })
    expect(args.tty).toMatchObject({ type: 'boolean', alias: 't' })
  })
})
