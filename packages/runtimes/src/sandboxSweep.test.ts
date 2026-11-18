import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { execa } from 'execa'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SandboxShellRunner } from './sandboxSweep'
import {
  getSandboxAgentPrefix,
  listQuimbySandboxes,
  localSandboxShellRunner,
  parseSandboxListing,
  parseSandboxRemoval,
  removeQuimbySandboxes,
  selectAgentSandboxes,
  sweepAgentSandboxes,
} from './sandboxSweep'

const A = 'aaaaaaaa-1111-2222-3333-444444444444'
const B = 'bbbbbbbb-1111-2222-3333-444444444444'
const A1 = 'qb-aaaaaaaa-0123456789ab'
const A2 = 'qb-aaaaaaaa-ba9876543210'
const B1 = 'qb-bbbbbbbb-0123456789ab'

let dir = ''

// Stub CLIs on PATH: the scripts are the part most likely to be wrong, so they run for real.
async function stubCli(name: string, body: string): Promise<void> {
  const path = join(dir, 'bin', name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}

function runner(): SandboxShellRunner {
  return async (script, input) => {
    const { stdout } = await execa('sh', ['-c', script], {
      env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir },
      extendEnv: false,
      reject: false,
      ...(input === undefined ? {} : { input }),
    })
    return stdout
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qb-sandbox-sweep-'))
  await mkdir(join(dir, 'bin'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('getSandboxAgentPrefix', () => {
  it('reads the agent prefix only from an exact quimby sandbox name', () => {
    expect(getSandboxAgentPrefix(A1)).toBe('aaaaaaaa')
    expect(getSandboxAgentPrefix('qb-aaaaaaaa')).toBeNull() // a tmux session, not a sandbox
    expect(getSandboxAgentPrefix('my-sandbox')).toBeNull()
    expect(getSandboxAgentPrefix(`${A1}x`)).toBeNull()
  })
})

describe('listQuimbySandboxes', () => {
  it('finds quimby names in a table, ignoring other sandboxes and the header', async () => {
    await stubCli(
      'sbx',
      `[ "$1" = ls ] && printf 'NAME  AGENT  STATUS\\n${A1}  claude  running\\nother-box  codex  stopped\\n${B1}  claude  stopped\\n'`,
    )
    const out = await listQuimbySandboxes(runner())
    expect(out.clis).toEqual(['sbx'])
    expect(out.sandboxes).toEqual([
      { cli: 'sbx', name: A1 },
      { cli: 'sbx', name: B1 },
    ])
  })

  it('reads JSON output just as well, and asks openshell too', async () => {
    await stubCli('openshell', `printf '[{"name":"${A2}","state":"up"}]\\n'`)
    const out = await listQuimbySandboxes(runner())
    expect(out).toEqual({ clis: ['openshell'], sandboxes: [{ cli: 'openshell', name: A2 }] })
  })

  it('reports no CLI rather than an empty listing when none is installed', async () => {
    expect(await listQuimbySandboxes(runner())).toEqual({ clis: [], sandboxes: [] })
  })
})

describe('localSandboxShellRunner', () => {
  it('runs a script with stdin on this machine', async () => {
    expect(await localSandboxShellRunner()('cat', 'hi')).toBe('hi')
  })
})

describe('parseSandboxListing', () => {
  it('ignores noise and dedupes', () => {
    const out = parseSandboxListing(
      `motd\nQBSBXCLI\tsbx\nQBSBX\tsbx\t${A1}\nQBSBX\tsbx\t${A1}\nQBSBX\tsbx\tnot-ours\nQBSBX\tdocker\t${A1}\n`,
    )
    expect(out).toEqual({ clis: ['sbx'], sandboxes: [{ cli: 'sbx', name: A1 }] })
  })
})

describe('parseSandboxRemoval', () => {
  it('splits ok from fail', () => {
    expect(parseSandboxRemoval(`QBSBXRM\tsbx\t${A1}\tok\nQBSBXRM\tsbx\t${A2}\tfail\n`)).toEqual({
      removed: [{ cli: 'sbx', name: A1 }],
      failed: [{ cli: 'sbx', name: A2 }],
    })
  })
})

describe('removeQuimbySandboxes', () => {
  it('prefers rm --force, falls back to plain rm, and never feeds the name list to the CLI', async () => {
    // A CLI without --force, that also reads stdin (as a confirmation prompt would).
    await stubCli(
      'sbx',
      `cat >/dev/null; [ "$2" = --force ] && exit 1; echo "$@" >> "${join(dir, 'rm.log')}"`,
    )
    const out = await removeQuimbySandboxes(runner(), [
      { cli: 'sbx', name: A1 },
      { cli: 'sbx', name: A2 },
    ])
    expect(out.removed.map((s) => s.name)).toEqual([A1, A2])
    expect((await readFile(join(dir, 'rm.log'), 'utf8')).trim().split('\n')).toEqual([
      `rm ${A1}`,
      `rm ${A2}`,
    ])
  })

  it('reports a removal the CLI refused as failed', async () => {
    await stubCli('sbx', 'exit 1')
    const out = await removeQuimbySandboxes(runner(), [{ cli: 'sbx', name: A1 }])
    expect(out).toEqual({ removed: [], failed: [{ cli: 'sbx', name: A1 }] })
  })

  it('never passes a name that is not a quimby sandbox', async () => {
    await stubCli('sbx', `echo "$@" >> "${join(dir, 'rm.log')}"`)
    const out = await removeQuimbySandboxes(runner(), [{ cli: 'sbx', name: 'important-box' }])
    expect(out.removed).toEqual([])
  })
})

describe('selectAgentSandboxes', () => {
  it('matches on the agent-id prefix, every command variant included', () => {
    const all = [A1, A2, B1].map((name) => ({ cli: 'sbx' as const, name }))
    expect(selectAgentSandboxes(all, [A]).map((s) => s.name)).toEqual([A1, A2])
  })
})

describe('sweepAgentSandboxes', () => {
  it("removes only the named agents' sandboxes", async () => {
    await stubCli(
      'sbx',
      `case "$1" in ls) printf '${A1}\\n${A2}\\n${B1}\\n';; rm) echo "$@" >> "${join(dir, 'rm.log')}";; esac`,
    )
    const out = await sweepAgentSandboxes(runner(), [A])
    expect(out.removed.map((s) => s.name)).toEqual([A1, A2])
    const log = await readFile(join(dir, 'rm.log'), 'utf8')
    expect(log).not.toContain(B1)
  })

  it('does nothing for no agents', async () => {
    expect(await sweepAgentSandboxes(runner(), [B].slice(1))).toEqual({
      clis: [],
      removed: [],
      failed: [],
    })
  })
})
