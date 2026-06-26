import { join } from 'pathe'
import { ensureDir, writeText } from '../utils/fs.js'
import * as git from '../utils/git.js'
import { renderSandboxClaudeMd } from './template.js'
import type { SandboxConfig } from '../types/config.js'
import type { SandboxState } from '../types/workspace.js'
import type { SandboxTransport } from './transport/types.js'

export async function scaffoldSandbox(opts: {
  workspacePath: string
  sandboxName: string
  sourceRepo: string
  sourceRef: string
  config: SandboxConfig
}): Promise<SandboxState> {
  const { workspacePath, sandboxName, sourceRepo, sourceRef, config } = opts
  const sandboxDir = join(workspacePath, 'sandboxes', sandboxName)
  const repoDir = join(sandboxDir, 'repo')
  const metaDir = join(sandboxDir, '.sandbox')

  await ensureDir(join(metaDir, 'bundles'))
  await ensureDir(join(metaDir, 'inbox'))
  await ensureDir(join(metaDir, 'messages'))

  await git.clone(sourceRepo, repoDir, { ref: sourceRef })
  await git.tag(repoDir, 'ao/seed')

  const seedCommit = await git.getCurrentRef(repoDir)

  await writeText(join(metaDir, 'assignment.md'), '')
  await writeText(join(metaDir, 'status.md'), 'idle')

  const claudeMd = renderSandboxClaudeMd({ sandboxName, config })
  await writeText(join(sandboxDir, 'CLAUDE.md'), claudeMd)

  return {
    name: sandboxName,
    status: 'idle',
    runtimeType: config.runtime.type,
    seedCommit,
    createdAt: new Date().toISOString(),
  }
}

export async function scaffoldRemoteSandbox(opts: {
  sandboxName: string
  sourceRepo: string
  sourceRef: string
  config: SandboxConfig
  transport: SandboxTransport
}): Promise<SandboxState> {
  const { sandboxName, sourceRepo, sourceRef, config, transport } = opts

  await transport.ensureDir('.sandbox/bundles')
  await transport.ensureDir('.sandbox/inbox')
  await transport.ensureDir('.sandbox/messages')

  let cloneUrl = sourceRepo
  if (!sourceRepo.startsWith('http') && !sourceRepo.startsWith('git@') && !sourceRepo.startsWith('ssh://')) {
    const remoteUrl = await git.getRemoteUrl(sourceRepo)
    if (!remoteUrl) {
      throw new Error(
        `Source repo "${sourceRepo}" is a local path with no remote URL. ` +
        `Remote sandboxes need an accessible URL.`,
      )
    }
    cloneUrl = remoteUrl
  }

  await transport.exec(['git', 'clone', '--branch', sourceRef, cloneUrl, 'repo'])
  await transport.exec(['git', 'tag', 'ao/seed'], { cwd: 'repo' })

  const seedResult = await transport.exec(['git', 'rev-parse', 'HEAD'], { cwd: 'repo' })
  const seedCommit = seedResult.stdout.trim()

  await transport.pushFile('.sandbox/assignment.md', '')
  await transport.pushFile('.sandbox/status.md', 'idle')

  const claudeMd = renderSandboxClaudeMd({ sandboxName, config })
  await transport.pushFile('CLAUDE.md', claudeMd)

  return {
    name: sandboxName,
    status: 'idle',
    runtimeType: config.runtime.type,
    seedCommit,
    createdAt: new Date().toISOString(),
    host: config.runtime.host,
    user: config.runtime.user,
    port: config.runtime.port,
    remotePath: transport.sandboxPath,
  }
}
