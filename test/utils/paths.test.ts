import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'pathe'
import {
  getAoHome,
  getWorkspacesDir,
  getRegistryPath,
  getWorkspacePath,
  getSandboxPath,
  getSandboxRepoPath,
  getSandboxMetaDir,
} from '../../src/utils/paths.js'

describe('getAoHome', () => {
  afterEach(() => {
    delete process.env.AO_HOME
  })

  it('defaults to ~/.ao', () => {
    delete process.env.AO_HOME
    expect(getAoHome()).toBe(join(homedir(), '.ao'))
  })

  it('respects AO_HOME env var', () => {
    process.env.AO_HOME = '/custom/ao'
    expect(getAoHome()).toBe('/custom/ao')
  })
})

describe('getWorkspacesDir', () => {
  it('returns <aoHome>/workspaces', () => {
    delete process.env.AO_HOME
    expect(getWorkspacesDir()).toBe(join(homedir(), '.ao', 'workspaces'))
  })
})

describe('getRegistryPath', () => {
  it('returns <aoHome>/workspaces.yaml', () => {
    delete process.env.AO_HOME
    expect(getRegistryPath()).toBe(join(homedir(), '.ao', 'workspaces.yaml'))
  })
})

describe('getWorkspacePath', () => {
  it('returns <workspacesDir>/<name>', () => {
    delete process.env.AO_HOME
    expect(getWorkspacePath('my-project')).toBe(
      join(homedir(), '.ao', 'workspaces', 'my-project'),
    )
  })
})

describe('getSandboxPath', () => {
  it('returns <workspacePath>/sandboxes/<name>', () => {
    expect(getSandboxPath('/ws', 'backend')).toBe('/ws/sandboxes/backend')
  })
})

describe('getSandboxRepoPath', () => {
  it('returns <sandboxPath>/repo', () => {
    expect(getSandboxRepoPath('/ws', 'backend')).toBe(
      '/ws/sandboxes/backend/repo',
    )
  })
})

describe('getSandboxMetaDir', () => {
  it('returns <sandboxPath>/.sandbox', () => {
    expect(getSandboxMetaDir('/ws', 'backend')).toBe(
      '/ws/sandboxes/backend/.sandbox',
    )
  })
})
