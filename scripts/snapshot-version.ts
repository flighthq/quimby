// Computes the snapshot version CI publishes to the `next` dist-tag on every green push to main,
// separate from the tag-triggered stable release (release.yml). Quimby ships one package, so this
// prints one computed version plus the dist-tag to publish it under; the CI job stamps it with
// `version:package` and publishes with `release -- --tag <tag>` so it lands on that channel and
// never touches `latest`.
//
// Scheme:
//   base    = apps/cli's current source version (the canonical latest; tag-independent, so a
//             missing or unpushed release tag never yields a stale base).
//   bumped  = base bumped by the highest conventional-commits level among the commits since the
//             last version tag (see version-scheme.ts for the pre-1.0 vs post-1.0 lanes). Either
//             way a snapshot sorts *above* the last release as its upcoming version, not as a
//             prerelease of it.
//   version = <bumped>-next.<count>.<sha>
//             count    commits since the last version tag (`git rev-list --count <tag>..HEAD`),
//                      resetting each release, so it reads as "Nth build toward the next version" —
//                      monotonic within a release cycle, so snapshots sort in commit order (a
//                      numeric prerelease identifier). Falls back to the total commit count when no
//                      version tag is reachable, which is the state before the first release.
//             <sha>    short commit sha, disambiguating the rare builds that share a <count>. (A hex
//                      sha that is all-digits with a leading zero is not a valid semver identifier —
//                      ~1 in a few hundred commits; tolerated as a one-off failed publish that
//                      self-heals on the next commit, rather than carrying a "g"-style prefix.)
//
// Only `main` is a snapshot channel. Flight runs a main/develop pair (edge/next); quimby is
// single-branch, so there is one channel and it is `next` — the conventional "ahead of latest" tag.
//
// Prints `version=<v>` and `tag=next` in GitHub Actions `$GITHUB_OUTPUT` key=value form, so the
// workflow captures them with `>> "$GITHUB_OUTPUT"`.
//
// Usage:
//   tsx scripts/snapshot-version.ts            branch from GITHUB_REF_NAME, else the current branch
//   tsx scripts/snapshot-version.ts <branch>   compute for an explicit branch

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyBump, detectBumpLevel } from './version-scheme'

const SNAPSHOT_CHANNEL = 'next'
const RELEASE_BRANCH = 'main'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const branch = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? gitBranch()
if (branch !== RELEASE_BRANCH) {
  console.error(
    `[snapshot-version] branch "${branch}" is not a release channel (expected ${RELEASE_BRANCH})`,
  )
  process.exit(1)
}

// The commit range since the last release drives both the bump level and the build count.
const tag = lastVersionTag()
const range = tag === undefined ? 'HEAD' : `${tag}..HEAD`
const bumped = applyBump(readCliVersion(), detectBumpLevel(commitMessages(range)))
const version = `${bumped}-${SNAPSHOT_CHANNEL}.${commitCount(range)}.${shortSha()}`
process.stdout.write(`version=${version}\ntag=${SNAPSHOT_CHANNEL}\n`)

// Raw bodies, NUL-delimited so a multi-line `BREAKING CHANGE:` footer stays intact.
function commitMessages(commitRange: string): string[] {
  return git('log', '--format=%B%x00', commitRange)
    .split('\0')
    .map((message) => message.trim())
    .filter(Boolean)
}

// Commits in `range` (since the last release), so the number stays small and resets each version —
// a monotonic sort key. The caller passes `HEAD` when no version tag is reachable.
function commitCount(commitRange: string): string {
  return git('rev-list', '--count', commitRange)
}

function git(...args: readonly string[]): string {
  return execFileSync('git', args as string[], { cwd: root, encoding: 'utf8' }).trim()
}

function gitBranch(): string {
  return git('rev-parse', '--abbrev-ref', 'HEAD')
}

// The nearest reachable bare numeric version tag (0.2.0), matched so non-version tags — quimby/seed
// above all, which every agent clone carries — can't stand in for it. `git describe` exits non-zero
// when none is reachable, which is the pre-first-release state — expected before the first release,
// so its "fatal: No names found" is kept off stderr rather than read as a build failure.
function lastVersionTag(): string | undefined {
  try {
    return execFileSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', '[0-9]*.[0-9]*.[0-9]*'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
  } catch {
    return undefined
  }
}

function readCliVersion(): string {
  const manifest = JSON.parse(readFileSync(join(root, 'apps', 'cli', 'package.json'), 'utf8'))
  return manifest.version as string
}

function shortSha(): string {
  return git('rev-parse', '--short=7', 'HEAD')
}
