import { defineCommand } from 'citty'
import { join } from 'pathe'
import { resolveWorkspace } from '../../core/workspace.js'
import { readBundle } from '../../core/bundle.js'
import { getSandboxPath } from '../../utils/paths.js'
import { AoError } from '../../utils/errors.js'

export default defineCommand({
  meta: {
    name: 'review',
    description: 'Review a bundle (show metadata and diff)',
  },
  args: {
    sandbox: {
      type: 'positional',
      description: 'Sandbox name',
      required: true,
    },
    bundle: {
      type: 'positional',
      description: 'Bundle ID',
      required: true,
    },
  },
  async run({ args }) {
    const { workspacePath } = await resolveWorkspace()
    const sandboxPath = getSandboxPath(workspacePath, args.sandbox)
    const bundlePath = join(sandboxPath, '.sandbox', 'bundles', args.bundle)

    let result: Awaited<ReturnType<typeof readBundle>>
    try {
      result = await readBundle(bundlePath)
    } catch {
      throw new AoError(
        `Bundle "${args.bundle}" not found in sandbox "${args.sandbox}"`,
      )
    }

    const { meta, squashedDiff } = result

    console.log(`\nBundle: ${meta.id}`)
    console.log(`Sandbox: ${meta.sandbox}`)
    console.log(`Description: ${meta.description}`)
    console.log(`Suggested message: ${meta.suggestedMessage}`)
    console.log(`Created: ${meta.createdAt}`)
    console.log(`Commits: ${meta.commits.length}`)

    if (meta.commits.length > 0) {
      console.log('\nCommit history:')
      for (const c of meta.commits) {
        console.log(`  ${c.hash.slice(0, 8)} ${c.message}`)
      }
    }

    if (meta.dependencies?.length) {
      console.log(`\nDependencies: ${meta.dependencies.join(', ')}`)
    }

    if (squashedDiff) {
      console.log('\n--- squashed.diff ---')
      console.log(squashedDiff)
    }
  },
})
