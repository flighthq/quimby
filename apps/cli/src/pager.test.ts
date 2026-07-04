import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn }))

import { page } from './pager'

// A minimal stand-in for the ChildProcess `page` drives: it records `on` handlers
// so a test can fire 'error'/'close' and captures whatever is written to stdin.
function fakeChild() {
  const handlers: Record<string, (arg?: unknown) => void> = {}
  const stdinHandlers: Record<string, () => void> = {}
  const written: string[] = []
  return {
    on(event: string, cb: (arg?: unknown) => void) {
      handlers[event] = cb
      return this
    },
    stdin: {
      on(event: string, cb: () => void) {
        stdinHandlers[event] = cb
      },
      write(chunk: string) {
        written.push(chunk)
      },
      end() {},
    },
    emit(event: string, arg?: unknown) {
      handlers[event]?.(arg)
    },
    written,
  }
}

const originalTTY = process.stdout.isTTY
const originalGitPager = process.env.GIT_PAGER
const originalPager = process.env.PAGER

beforeEach(() => {
  spawn.mockReset()
  delete process.env.GIT_PAGER
  delete process.env.PAGER
})

afterEach(() => {
  process.stdout.isTTY = originalTTY
  if (originalGitPager === undefined) delete process.env.GIT_PAGER
  else process.env.GIT_PAGER = originalGitPager
  if (originalPager === undefined) delete process.env.PAGER
  else process.env.PAGER = originalPager
  vi.restoreAllMocks()
})

describe('page', () => {
  it('prints plainly and never spawns a pager when not attached to a TTY', async () => {
    process.stdout.isTTY = false
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await page('hello world')

    expect(log).toHaveBeenCalledWith('hello world')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('pipes the text into the pager and resolves when the pager closes', async () => {
    process.stdout.isTTY = true
    const child = fakeChild()
    spawn.mockReturnValue(child)

    const done = page('a long diff')
    child.emit('close')
    await done

    expect(child.written).toEqual(['a long diff'])
  })

  it('defaults to `less -RFX` when no pager env var is set', async () => {
    process.stdout.isTTY = true
    const child = fakeChild()
    spawn.mockReturnValue(child)

    const done = page('body')
    child.emit('close')
    await done

    expect(spawn).toHaveBeenCalledWith('less -RFX', expect.objectContaining({ shell: true }))
  })

  it('honors GIT_PAGER over PAGER', async () => {
    process.stdout.isTTY = true
    process.env.GIT_PAGER = 'more'
    process.env.PAGER = 'bat'
    const child = fakeChild()
    spawn.mockReturnValue(child)

    const done = page('body')
    child.emit('close')
    await done

    expect(spawn).toHaveBeenCalledWith('more', expect.anything())
  })

  it('falls back to plain printing and resolves when the pager fails to spawn', async () => {
    process.stdout.isTTY = true
    const child = fakeChild()
    spawn.mockReturnValue(child)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const done = page('fallback text')
    child.emit('error')
    await done

    expect(log).toHaveBeenCalledWith('fallback text')
  })
})
