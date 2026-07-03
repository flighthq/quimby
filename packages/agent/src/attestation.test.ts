import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentDir, getAgentRepoDir } from '@quimbyhq/paths'
import type { AgentState } from '@quimbyhq/types'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getAgentAttestation, getAgentHeadHash, parseAttestation } from './attestation'

const BLOCK = [
  '# Status',
  '',
  '```quimby-attest',
  'command: npm run ci',
  'result: pass',
  'summary: 78 files, 646 tests green',
  'atCommit: a1b2c3d',
  '```',
  '',
].join('\n')

describe('getAgentAttestation', () => {
  let dir: string
  beforeEach(async () => {
    dir = join(tmpdir(), `quimby-attest-${crypto.randomUUID()}`)
    await mkdir(getAgentDir(dir, 'a1'), { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const agent = { id: 'a1', name: 'alice', location: { type: 'local' } } as AgentState

  it('reads and parses the attestation from a local agent status.md', async () => {
    await writeFile(join(getAgentDir(dir, 'a1'), 'status.md'), BLOCK)
    expect(await getAgentAttestation(dir, 'proj', agent)).toEqual({
      command: 'npm run ci',
      result: 'pass',
      summary: '78 files, 646 tests green',
      atCommit: 'a1b2c3d',
    })
  })

  it('returns null when status.md is absent', async () => {
    expect(await getAgentAttestation(dir, 'proj', agent)).toBeNull()
  })
})

describe('getAgentHeadHash', () => {
  let dir: string
  beforeEach(async () => {
    dir = join(tmpdir(), `quimby-head-${crypto.randomUUID()}`)
    const repo = getAgentRepoDir(dir, 'a1')
    await mkdir(repo, { recursive: true })
    await execa('git', ['init'], { cwd: repo })
    await execa('git', ['config', 'user.email', 't@t'], { cwd: repo })
    await execa('git', ['config', 'user.name', 't'], { cwd: repo })
    await writeFile(join(repo, 'f.txt'), 'x')
    await execa('git', ['add', '-A'], { cwd: repo })
    await execa('git', ['commit', '-m', 'init'], { cwd: repo })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const agent = { id: 'a1', name: 'alice', location: { type: 'local' } } as AgentState

  it("returns the local agent repo's HEAD commit", async () => {
    const head = (
      await execa('git', ['rev-parse', 'HEAD'], { cwd: getAgentRepoDir(dir, 'a1') })
    ).stdout.trim()
    expect(await getAgentHeadHash(dir, 'proj', agent)).toBe(head)
  })

  it('returns null when the agent repo is unreadable', async () => {
    const ghost = { id: 'missing', name: 'ghost', location: { type: 'local' } } as AgentState
    expect(await getAgentHeadHash(dir, 'proj', ghost)).toBeNull()
  })
})

describe('parseAttestation', () => {
  it('parses a full block', () => {
    expect(parseAttestation(BLOCK)).toEqual({
      command: 'npm run ci',
      result: 'pass',
      summary: '78 files, 646 tests green',
      atCommit: 'a1b2c3d',
    })
  })

  it('keeps only command and result when summary/atCommit are absent', () => {
    const text = '```quimby-attest\ncommand: make test\nresult: fail\n```'
    expect(parseAttestation(text)).toEqual({ command: 'make test', result: 'fail' })
  })

  it('returns null with no block', () => {
    expect(parseAttestation('# just a status, no attestation')).toBeNull()
  })

  it('returns null when result is not pass|fail (a malformed self-report is not trusted)', () => {
    expect(parseAttestation('```quimby-attest\ncommand: x\nresult: maybe\n```')).toBeNull()
  })

  it('returns null when command is missing', () => {
    expect(parseAttestation('```quimby-attest\nresult: pass\n```')).toBeNull()
  })

  it('takes the last block when several are present (most recent wins)', () => {
    const text =
      '```quimby-attest\ncommand: old\nresult: fail\n```\n' +
      '```quimby-attest\ncommand: new\nresult: pass\n```'
    expect(parseAttestation(text)?.command).toBe('new')
    expect(parseAttestation(text)?.result).toBe('pass')
  })
})
