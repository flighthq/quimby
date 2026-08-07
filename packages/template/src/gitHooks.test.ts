import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { renderAgentPreCommitHook } from './gitHooks'

const dirs: string[] = []

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

/** A repo with the hook installed, seeded with a shared file and one the agent owns. */
function makeAgentRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'qhook-'))
  dirs.push(repo)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: GIT_ENV })
  writeFileSync(join(repo, 'shared.ts'), 'v1\n')
  writeFileSync(join(repo, 'mine.ts'), 'mine\n')
  execFileSync('git', ['add', '-A'], { cwd: repo, env: GIT_ENV })
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo, env: GIT_ENV })
  execFileSync('git', ['tag', 'quimby/seed'], { cwd: repo, env: GIT_ENV })
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), renderAgentPreCommitHook(), {
    mode: 0o755,
  })
  return repo
}

/** Land a peer's change and deliver it as `quimby/base`, without touching the agent's checkout. */
function deliverBase(repo: string): void {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
  execFileSync('git', ['checkout', '-q', '--detach'], { cwd: repo, env: GIT_ENV })
  writeFileSync(join(repo, 'shared.ts'), 'v2-peer\n')
  execFileSync('git', ['commit', '-q', '-am', 'peer work'], { cwd: repo, env: GIT_ENV })
  execFileSync('git', ['tag', '-f', 'quimby/base', 'HEAD'], { cwd: repo, env: GIT_ENV })
  execFileSync('git', ['checkout', '-q', '-B', 'main', head], { cwd: repo, env: GIT_ENV })
}

/** Commit, returning git's merged output — the hook writes to stderr. */
function commit(repo: string, message: string): string {
  return execFileSync('sh', ['-c', `git commit -m ${JSON.stringify(message)} 2>&1`], {
    cwd: repo,
    encoding: 'utf-8',
    env: GIT_ENV,
  })
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      execFileSync('rm', ['-rf', d])
    } catch {
      /* best-effort temp cleanup */
    }
  }
})

describe('renderAgentPreCommitHook', () => {
  it('is POSIX sh that parses', () => {
    const repo = makeAgentRepo()
    // `sh -n` fails loudly on a syntax error; a hook that cannot parse is silently skipped by git,
    // which would make this whole safety net a no-op nobody notices.
    expect(() =>
      execFileSync('sh', ['-n', join(repo, '.git', 'hooks', 'pre-commit')]),
    ).not.toThrow()
  })

  it('says nothing when no base has been delivered yet', () => {
    const repo = makeAgentRepo()
    writeFileSync(join(repo, 'mine.ts'), 'changed\n')
    execFileSync('git', ['add', '-A'], { cwd: repo, env: GIT_ENV })
    expect(commit(repo, 'my work')).not.toContain('quimby: WARNING')
  })

  it('says nothing when the staged files are the agent’s own', () => {
    const repo = makeAgentRepo()
    deliverBase(repo)
    writeFileSync(join(repo, 'mine.ts'), 'changed\n')
    execFileSync('git', ['add', 'mine.ts'], { cwd: repo, env: GIT_ENV })
    // A false positive here would train the agent to ignore the warning, so this matters as much
    // as the detection below.
    expect(commit(repo, 'font-formats')).not.toContain('quimby: WARNING')
  })

  // The incident this exists for: an unapplied base, a stale copy of a peer's file staged
  // alongside real work, committed under an unrelated message.
  it('warns when a staged file also changed on the undelivered base', () => {
    const repo = makeAgentRepo()
    deliverBase(repo)
    writeFileSync(join(repo, 'shared.ts'), 'v1-stale\n')
    execFileSync('git', ['add', 'shared.ts'], { cwd: repo, env: GIT_ENV })
    const out = commit(repo, 'feat: font-formats')
    expect(out).toContain('quimby: WARNING')
    expect(out).toContain('shared.ts')
    expect(out).toContain('./agent.sh rebase')
  })

  it('never blocks — the commit still lands after the warning', () => {
    const repo = makeAgentRepo()
    deliverBase(repo)
    writeFileSync(join(repo, 'shared.ts'), 'v1-stale\n')
    execFileSync('git', ['add', 'shared.ts'], { cwd: repo, env: GIT_ENV })
    commit(repo, 'feat: font-formats')
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim()
    expect(subject).toBe('feat: font-formats')
  })

  it('goes quiet again once the base has been applied', () => {
    const repo = makeAgentRepo()
    deliverBase(repo)
    execFileSync('git', ['rebase', 'quimby/base'], { cwd: repo, env: GIT_ENV })
    writeFileSync(join(repo, 'shared.ts'), 'v3-mine\n')
    execFileSync('git', ['add', 'shared.ts'], { cwd: repo, env: GIT_ENV })
    // Editing the same file is perfectly fine once you are building on the landed version.
    expect(commit(repo, 'my change on top')).not.toContain('quimby: WARNING')
  })
})
