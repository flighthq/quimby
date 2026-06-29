import { describe, expect, it } from 'vitest'

import {
  remoteAgentDir,
  remoteAgentRepoDir,
  remoteProjectRoot,
  remoteQuimbyDir,
  tmuxSessionName,
} from './remotePaths'

describe('remoteAgentDir', () => {
  it('returns remote agent dir with agent name', () => {
    expect(remoteAgentDir('proj-id', 'alice')).toBe(
      '~/.quimby/workspaces/proj-id/.quimby/agents/alice',
    )
  })

  it('uses base override', () => {
    expect(remoteAgentDir('proj-id', 'alice', '/base')).toBe('/base/.quimby/agents/alice')
  })
})

describe('remoteAgentRepoDir', () => {
  it('returns repo subdir of remote agent dir', () => {
    expect(remoteAgentRepoDir('proj-id', 'alice')).toBe(
      '~/.quimby/workspaces/proj-id/.quimby/agents/alice/repo',
    )
  })

  it('uses base override', () => {
    expect(remoteAgentRepoDir('proj-id', 'alice', '/base')).toBe('/base/.quimby/agents/alice/repo')
  })
})

describe('remoteProjectRoot', () => {
  it('returns default path when no base provided', () => {
    expect(remoteProjectRoot('proj-id')).toBe('~/.quimby/workspaces/proj-id')
  })

  it('uses base override when provided', () => {
    expect(remoteProjectRoot('proj-id', '/custom/path')).toBe('/custom/path')
  })
})

describe('remoteQuimbyDir', () => {
  it('returns .quimby under remote project root', () => {
    expect(remoteQuimbyDir('proj-id')).toBe('~/.quimby/workspaces/proj-id/.quimby')
  })

  it('uses base override', () => {
    expect(remoteQuimbyDir('proj-id', '/base')).toBe('/base/.quimby')
  })
})

describe('tmuxSessionName', () => {
  it('returns qb-<first8>-<first8> format', () => {
    const projectId = 'abcdef12-1234-5678-9abc-def012345678'
    const agentId = '98765432-abcd-ef01-2345-6789abcdef01'
    expect(tmuxSessionName(projectId, agentId)).toBe('qb-abcdef12-98765432')
  })

  it('truncates UUIDs to 8 characters', () => {
    const result = tmuxSessionName('aabbccdd-xxxx', 'eeffgghh-yyyy')
    expect(result).toBe('qb-aabbccdd-eeffgghh')
  })
})
