import { join } from 'pathe'
import { cp, ensureDir, exists } from '../utils/fs.js'
import { AoError } from '../utils/errors.js'
import type { SandboxTransport } from './transport/types.js'

export async function sendBundle(opts: {
  workspacePath: string
  fromSandbox: string
  toSandbox: string
  bundleId: string
}): Promise<void> {
  const { workspacePath, fromSandbox, toSandbox, bundleId } = opts

  const srcDir = join(
    workspacePath,
    'sandboxes',
    fromSandbox,
    '.sandbox',
    'bundles',
    bundleId,
  )

  if (!(await exists(srcDir))) {
    throw new AoError(
      `Bundle "${bundleId}" not found in sandbox "${fromSandbox}"`,
    )
  }

  const destDir = join(
    workspacePath,
    'sandboxes',
    toSandbox,
    '.sandbox',
    'inbox',
    `from-${fromSandbox}`,
    bundleId,
  )

  await ensureDir(destDir)
  await cp(srcDir, destDir, { recursive: true })
}

export async function sendBundleViaTransport(opts: {
  fromTransport: SandboxTransport
  toTransport: SandboxTransport
  fromSandbox: string
  bundleId: string
  tempDir: string
}): Promise<void> {
  const { fromTransport, toTransport, fromSandbox, bundleId, tempDir } = opts

  const srcPath = `.sandbox/bundles/${bundleId}`
  if (!(await fromTransport.exists(srcPath))) {
    throw new AoError(
      `Bundle "${bundleId}" not found in sandbox "${fromSandbox}"`,
    )
  }

  const localTemp = join(tempDir, bundleId)
  await fromTransport.pullDir(srcPath, localTemp)

  const destPath = `.sandbox/inbox/from-${fromSandbox}/${bundleId}`
  await toTransport.pushDir(localTemp, destPath)
}
