import { describe, expect, it, vi } from 'vitest'

const execa = vi.hoisted(() => vi.fn())
vi.mock('execa', () => ({ execa }))

import { bestEffortExec, requireRuntimeCli } from './probe'

describe('bestEffortExec', () => {
  it('runs the command and resolves on success', async () => {
    execa.mockResolvedValueOnce({ stdout: '' })
    await expect(bestEffortExec('sbx', ['rm', 'x'])).resolves.toBeUndefined()
    expect(execa).toHaveBeenCalledWith('sbx', ['rm', 'x'])
  })

  it('swallows any failure (teardown is advisory)', async () => {
    execa.mockRejectedValueOnce(new Error('boom'))
    await expect(bestEffortExec('sbx', ['rm', 'x'])).resolves.toBeUndefined()
  })
})

describe('requireRuntimeCli', () => {
  it('resolves when the CLI is present', async () => {
    execa.mockResolvedValueOnce({ stdout: 'v1' })
    await expect(requireRuntimeCli('sbx', 'sbx')).resolves.toBeUndefined()
  })

  it('throws a clear error when the binary is missing (ENOENT)', async () => {
    execa.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(requireRuntimeCli('sbx', 'sbx')).rejects.toThrow(/isn't on your PATH/)
  })

  it('treats a non-ENOENT failure as "present" (a quirky --version is not a missing CLI)', async () => {
    execa.mockRejectedValueOnce(Object.assign(new Error('exit 1'), { exitCode: 1 }))
    await expect(requireRuntimeCli('sbx', 'sbx')).resolves.toBeUndefined()
  })
})
