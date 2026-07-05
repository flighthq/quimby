import { describe, expect, it } from 'vitest'

import {
  dashboardSessionName,
  dashboardViewPrefix,
  dashboardViewSessionName,
  remoteAgentDir,
  remoteAgentHandoffDir,
  remoteAgentHandoffInProcessedDir,
  remoteAgentHandoffInReceivedDir,
  remoteAgentHandoffOutDraftDir,
  remoteAgentHandoffOutQueuedDir,
  remoteAgentHandoffOutSentDir,
  remoteAgentRepoDir,
  remoteAgentStatusMirrorDir,
  remoteProjectRoot,
  remoteQuimbyDir,
  remoteTmuxConfigPath,
  tmuxSessionName,
} from './remotePaths'

describe('dashboardSessionName', () => {
  it('uses the full project id to avoid cross-project prefix collisions', () => {
    const projectId = '111cde39-eb54-4541-9209-ed94966c0427'
    expect(dashboardSessionName(projectId)).toBe(`qb-dash-${projectId}`)
  })
})

describe('dashboardViewPrefix', () => {
  it('uses the full project id to avoid cross-project prefix collisions', () => {
    const projectId = '111cde39-eb54-4541-9209-ed94966c0427'
    expect(dashboardViewPrefix(projectId)).toBe(`qbv-${projectId}-`)
  })
})

describe('dashboardViewSessionName', () => {
  it('appends the pane index to the full project-scoped view prefix', () => {
    const projectId = '111cde39-eb54-4541-9209-ed94966c0427'
    expect(dashboardViewSessionName(projectId, 2)).toBe(`qbv-${projectId}-2`)
  })
})

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

describe('remoteAgentHandoffDir', () => {
  it('returns the handoff root under the remote agent dir', () => {
    expect(remoteAgentHandoffDir('proj-id', 'alice', '/base')).toBe(
      '/base/.quimby/agents/alice/handoff',
    )
  })
})

describe('remoteAgentHandoffInProcessedDir', () => {
  it('returns the remote in/processed dir', () => {
    expect(remoteAgentHandoffInProcessedDir('proj-id', 'alice', '/base')).toBe(
      '/base/.quimby/agents/alice/handoff/in/processed',
    )
  })
})

describe('remoteAgentHandoffInReceivedDir', () => {
  it('returns the remote in/received dir', () => {
    expect(remoteAgentHandoffInReceivedDir('proj-id', 'alice', '/base')).toBe(
      '/base/.quimby/agents/alice/handoff/in/received',
    )
  })
})

describe('remoteAgentHandoffOutDraftDir', () => {
  it('returns the remote out/draft dir', () => {
    expect(remoteAgentHandoffOutDraftDir('proj-id', 'alice', '/base')).toBe(
      '/base/.quimby/agents/alice/handoff/out/draft',
    )
  })
})

describe('remoteAgentHandoffOutQueuedDir', () => {
  it('returns the remote out/queued scan root', () => {
    expect(remoteAgentHandoffOutQueuedDir('proj-id', 'alice', '/base')).toBe(
      '/base/.quimby/agents/alice/handoff/out/queued',
    )
  })
})

describe('remoteAgentHandoffOutSentDir', () => {
  it('returns the remote out/sent ledger dir', () => {
    expect(remoteAgentHandoffOutSentDir('proj-id', 'alice', '/base')).toBe(
      '/base/.quimby/agents/alice/handoff/out/sent',
    )
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

describe('remoteAgentStatusMirrorDir', () => {
  it('returns the status-mirror dir at the remote agent root, outside handoff/', () => {
    expect(remoteAgentStatusMirrorDir('proj-id', 'alice', '/base')).toBe(
      '/base/.quimby/agents/alice/status',
    )
  })

  it('defaults under the workspace root when no base', () => {
    expect(remoteAgentStatusMirrorDir('proj-id', 'alice')).toBe(
      '~/.quimby/workspaces/proj-id/.quimby/agents/alice/status',
    )
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

describe('remoteTmuxConfigPath', () => {
  it('returns tmux.conf under the remote .quimby dir', () => {
    expect(remoteTmuxConfigPath('proj-id')).toBe('~/.quimby/workspaces/proj-id/.quimby/tmux.conf')
  })
})

describe('tmuxSessionName', () => {
  it('returns qb-<agentId first8> format', () => {
    const agentId = '98765432-abcd-ef01-2345-6789abcdef01'
    expect(tmuxSessionName(agentId)).toBe('qb-98765432')
  })

  it('truncates the agent UUID to 8 characters', () => {
    expect(tmuxSessionName('eeffgghh-yyyy')).toBe('qb-eeffgghh')
  })
})
