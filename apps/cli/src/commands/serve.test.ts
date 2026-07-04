import { describe, expect, it, vi } from 'vitest'

const stopServer = vi.hoisted(() => vi.fn(async () => null as { pid: number; port: number } | null))
const getServerInfo = vi.hoisted(() => vi.fn(async () => null))
const startServer = vi.hoisted(() => vi.fn(async () => ({ port: 7749, stop: async () => {} })))
const logger = vi.hoisted(() => ({
  start: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@quimbyhq/server', () => ({ stopServer, getServerInfo, startServer }))
vi.mock('@quimbyhq/utils', () => ({ logger }))

let resolveWorkspaceImpl: () => Promise<{ repoRoot: string }>

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(() => resolveWorkspaceImpl()),
}))

describe('runServeCommand', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./serve')
    expect(typeof cmd.run).toBe('function')
  })

  it('formats serve log lines with a local timestamp', async () => {
    const { formatServeLogMessage } = await import('./serve')
    expect(formatServeLogMessage('Polling every 5s', new Date(2026, 0, 2, 3, 4, 5))).toBe(
      '[03:04:05] Polling every 5s',
    )
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

  it('is idempotent: a server already running is a no-op, not an error', async () => {
    resolveWorkspaceImpl = async () => ({ repoRoot: '/fake/root' })
    getServerInfo.mockResolvedValueOnce({ pid: 7, port: 7749 } as never)
    startServer.mockClear()
    const { default: cmd } = await import('./serve')
    await expect(cmd.run!({ args: {} } as never)).resolves.toBeUndefined()
    expect(startServer).not.toHaveBeenCalled()
  })

  it('passes a timestamping reporter to the server', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5))
    try {
      resolveWorkspaceImpl = async () => ({ repoRoot: '/fake/root' })
      getServerInfo.mockResolvedValueOnce(null)
      startServer.mockClear()
      logger.info.mockClear()

      const { default: cmd } = await import('./serve')
      await cmd.run!({ args: {} } as never)

      const calls = startServer.mock.calls as unknown as [
        { reporter?: { info(message: string): void } },
      ][]
      const opts = calls.at(-1)?.[0]
      opts?.reporter?.info('Polling every 5s')

      expect(logger.info).toHaveBeenCalledWith('[03:04:05] Polling every 5s')
    } finally {
      vi.useRealTimers()
    }
  })
})
