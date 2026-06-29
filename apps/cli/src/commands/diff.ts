import * as git from '@quimbyhq/git'
import { readPack } from '@quimbyhq/pack'
import { getPackDir, getWorkerRepoDir, remoteWorkerRepoDir } from '@quimbyhq/paths'
import { getTransport } from '@quimbyhq/transport'
import type { WorkerLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { exists } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'
import { join } from 'pathe'

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

function colorizeDiff(diff: string): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return bold(line)
      if (line.startsWith('@@')) return cyan(line)
      if (line.startsWith('+')) return green(line)
      if (line.startsWith('-')) return red(line)
      if (line.startsWith('diff ')) return bold(yellow(line))
      return line
    })
    .join('\n')
}

async function getDiff(
  repoRoot: string,
  name: string,
  state: { id: string; workers: Record<string, { location?: WorkerLocation }> },
  stat: boolean,
): Promise<string> {
  const worker = state.workers[name]

  if (worker) {
    if (isSSH(worker.location)) {
      const transport = getTransport(worker.location)
      const rRepoDir = remoteWorkerRepoDir(state.id, name, worker.location.base)
      return stat
        ? transport.exec(`git diff --stat quimby/seed`, { cwd: rRepoDir })
        : transport.exec(`git diff quimby/seed`, { cwd: rRepoDir })
    }

    const repoPath = getWorkerRepoDir(repoRoot, name)
    if (stat) {
      const { stdout } = await execa('git', ['diff', '--stat', 'quimby/seed'], { cwd: repoPath })
      return stdout
    }
    return git.diff(repoPath, 'quimby/seed')
  }

  const packDir = getPackDir(repoRoot, name)
  if (await exists(join(packDir, 'meta.yaml'))) {
    if (stat) {
      const { meta } = await readPack(repoRoot, name)
      const count = meta.commits.length
      return `${meta.name}: ${count} commit${count === 1 ? '' : 's'} from ${meta.worker}`
    }
    const { squashedDiff } = await readPack(repoRoot, name)
    return squashedDiff
  }

  throw new Error(`"${name}" is not a worker or pack`)
}

export default defineCommand({
  meta: {
    name: 'diff',
    description: 'Show changes in a worker or pack',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Worker or pack name',
      required: true,
    },
    other: {
      type: 'positional',
      description: 'Second worker or pack (side-by-side)',
      required: false,
    },
    stat: {
      type: 'boolean',
      description: 'Show diffstat summary only',
      default: false,
    },
  },
  run,
})

async function run({ args }: { args: { name: string; other?: string; stat: boolean } }) {
  const { state, repoRoot } = await resolveWorkspace()

  if (args.other) {
    const [diffA, diffB] = await Promise.all([
      getDiff(repoRoot, args.name, state, args.stat),
      getDiff(repoRoot, args.other, state, args.stat),
    ])

    console.log(bold(`\n═══ ${args.name} ═══`))
    console.log(diffA ? (args.stat ? diffA : colorizeDiff(diffA)) : '  (no changes)')

    console.log(bold(`\n═══ ${args.other} ═══`))
    console.log(diffB ? (args.stat ? diffB : colorizeDiff(diffB)) : '  (no changes)')
    return
  }

  const diff = await getDiff(repoRoot, args.name, state, args.stat)

  if (!diff) {
    console.log('No changes.')
    return
  }

  console.log(args.stat ? diff : colorizeDiff(diff))
}
