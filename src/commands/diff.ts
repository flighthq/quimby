import { defineCommand } from 'citty'
import { join } from 'pathe'
import { resolveWorkspace } from '../core/workspace.js'
import { readPack } from '../core/pack.js'
import { getWorkerRepoDir, getPackDir } from '../utils/paths.js'
import { exists } from '../utils/fs.js'
import * as git from '../utils/git.js'
import { QuimbyError } from '../utils/errors.js'

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
  workers: Record<string, unknown>,
  stat: boolean,
): Promise<string> {
  if (workers[name]) {
    const repoPath = getWorkerRepoDir(repoRoot, name)
    if (stat) {
      const { execa } = await import('execa')
      const { stdout } = await execa('git', ['diff', '--stat', 'quimby/seed'], { cwd: repoPath })
      return stdout
    }
    return git.diff(repoPath, 'quimby/seed')
  }

  const packDir = getPackDir(repoRoot, name)
  if (await exists(join(packDir, 'meta.yaml'))) {
    if (stat) {
      const { meta } = await readPack(repoRoot, name)
      const files = meta.commits.length
      return `${meta.name}: ${files} commit${files === 1 ? '' : 's'} from ${meta.worker}`
    }
    const { squashedDiff } = await readPack(repoRoot, name)
    return squashedDiff
  }

  throw new QuimbyError(`"${name}" is not a worker or pack`)
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
  async run({ args }) {
    const { state, repoRoot } = await resolveWorkspace()

    if (args.other) {
      const [diffA, diffB] = await Promise.all([
        getDiff(repoRoot, args.name, state.workers, args.stat),
        getDiff(repoRoot, args.other, state.workers, args.stat),
      ])

      console.log(bold(`\n═══ ${args.name} ═══`))
      console.log(diffA ? (args.stat ? diffA : colorizeDiff(diffA)) : '  (no changes)')

      console.log(bold(`\n═══ ${args.other} ═══`))
      console.log(diffB ? (args.stat ? diffB : colorizeDiff(diffB)) : '  (no changes)')
    } else {
      const diff = await getDiff(repoRoot, args.name, state.workers, args.stat)

      if (!diff) {
        console.log('No changes.')
        return
      }

      console.log(args.stat ? diff : colorizeDiff(diff))
    }
  },
})
