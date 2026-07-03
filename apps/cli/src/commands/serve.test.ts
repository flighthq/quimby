import { describe, expect, it, vi } from 'vitest'

const stopServer = vi.hoisted(() => vi.fn(async () => null as { pid: number; port: number } | null))
const getServerInfo = vi.hoisted(() => vi.fn(async () => null))
const startServer = vi.hoisted(() => vi.fn(async () => ({ port: 7749, stop: async () => {} })))

vi.mock('@quimbyhq/server', () => ({ stopServer, getServerInfo, startServer }))

let resolveWorkspaceImpl: () => Promise<{ repoRoot: string }>

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(() => resolveWorkspaceImpl()),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./serve')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when workspace is missing', async () => {
    resolveWorkspaceImpl = () => Promise.reject(new Error('No quimby workspace found'))
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

  it('--stop stops the running server and never starts a new one', async () => {
    resolveWorkspaceImpl = async () => ({ repoRoot: '/fake/root' })
    stopServer.mockResolvedValueOnce({ pid: 42, port: 7749 })
    startServer.mockClear()
    const { default: cmd } = await import('./serve')
    await cmd.run!({ args: { stop: true } } as never)
    expect(stopServer).toHaveBeenCalledWith('/fake/root')
    expect(startServer).not.toHaveBeenCalled()
  })
})
