import { defineCommand } from 'citty'
import { resolveWorkspace } from '../../core/workspace.js'
import {
  createBundle,
  createBundleViaTransport,
  listBundles,
  listBundlesViaTransport,
} from '../../core/bundle.js'
import { createTransport } from '../../core/transport/index.js'
import { getSandboxPath } from '../../utils/paths.js'
import { AoError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'
import * as git from '../../utils/git.js'
import { join } from 'pathe'

function nextBundleId(existing: { id: string }[]): string {
  let max = 0
  for (const b of existing) {
    const match = b.id.match(/^(\d+)/)
    if (match) max = Math.max(max, parseInt(match[1], 10))
  }
  return String(max + 1).padStart(3, '0')
}

export default defineCommand({
  meta: {
    name: 'create',
    description: 'Create a bundle from a sandbox\'s work',
  },
  args: {
    sandbox: {
      type: 'positional',
      description: 'Sandbox name',
      required: true,
    },
    id: {
      type: 'string',
      description: 'Bundle ID (auto-generated if omitted)',
    },
    description: {
      type: 'string',
      alias: 'd',
      description: 'Bundle description (inferred from commits if omitted)',
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Suggested commit message (inferred from commits if omitted)',
    },
  },
  async run({ args }) {
    const { state, workspacePath } = await resolveWorkspace()
    const sandboxState = state.sandboxes[args.sandbox]

    if (!sandboxState) {
      throw new AoError(`Sandbox "${args.sandbox}" not found`)
    }

    const isRemote = !!(sandboxState.host && sandboxState.user)

    // Infer defaults from existing bundles and commit log
    let bundleId = args.id
    let description = args.description
    let suggestedMessage = args.message

    if (!bundleId || !description || !suggestedMessage) {
      if (isRemote) {
        const transport = createTransport(workspacePath, sandboxState)

        if (!bundleId) {
          const existing = await listBundlesViaTransport(transport)
          bundleId = nextBundleId(existing)
        }

        if (!description || !suggestedMessage) {
          const logResult = await transport.exec(
            ['git', 'log', 'ao/seed..HEAD', '--format=%s'],
            { cwd: 'repo' },
          )
          const subjects = logResult.stdout.split('\n').filter(Boolean)
          if (subjects.length === 0) {
            throw new AoError('No commits since ao/seed — nothing to bundle')
          }
          if (!suggestedMessage) {
            suggestedMessage =
              subjects.length === 1
                ? subjects[0]
                : subjects[subjects.length - 1]
          }
          if (!description) {
            description = subjects.join('; ')
          }
        }
      } else {
        const sandboxPath = getSandboxPath(workspacePath, args.sandbox)
        const repoPath = join(sandboxPath, 'repo')

        if (!bundleId) {
          const existing = await listBundles(sandboxPath)
          bundleId = nextBundleId(existing)
        }

        if (!description || !suggestedMessage) {
          const logOutput = await git.log(repoPath, 'ao/seed..HEAD', '%s')
          const subjects = logOutput.split('\n').filter(Boolean)
          if (subjects.length === 0) {
            throw new AoError('No commits since ao/seed — nothing to bundle')
          }
          if (!suggestedMessage) {
            suggestedMessage =
              subjects.length === 1
                ? subjects[0]
                : subjects[subjects.length - 1]
          }
          if (!description) {
            description = subjects.join('; ')
          }
        }
      }
    }

    logger.start(
      `Creating bundle "${bundleId}" from sandbox "${args.sandbox}"`,
    )

    let meta
    if (isRemote) {
      const transport = createTransport(workspacePath, sandboxState)
      meta = await createBundleViaTransport({
        transport,
        sandboxName: args.sandbox,
        bundleId,
        description,
        suggestedMessage,
      })
    } else {
      const sandboxPath = getSandboxPath(workspacePath, args.sandbox)
      meta = await createBundle({
        sandboxPath,
        sandboxName: args.sandbox,
        bundleId,
        description,
        suggestedMessage,
      })
    }

    logger.success(`Bundle "${meta.id}" created (${meta.commits.length} commits)`)
  },
})
