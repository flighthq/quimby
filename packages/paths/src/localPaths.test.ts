import { describe, expect, it } from 'vitest'

import {
  getAgentDir,
  getAgentHandoffDir,
  getAgentHandoffInProcessedDir,
  getAgentHandoffInReceivedDir,
  getAgentHandoffInReceivedParcelDir,
  getAgentHandoffOutDraftDir,
  getAgentHandoffOutDraftRecipientDir,
  getAgentHandoffOutQueuedDir,
  getAgentHandoffOutQueuedRecipientDir,
  getAgentHandoffOutSentDir,
  getAgentHandoffOutSentRecipientDir,
  getAgentRepoDir,
  getAgentsDir,
  getAgentStatusMirrorDir,
  getProjectRegistryPath,
  getQuimbyDir,
  getStagingDir,
  getStagingHandoffDir,
  getStatePath,
  getStorageRoot,
  getStorageWorkspaceDir,
  getTmuxConfigPath,
  getUserConfigDir,
  getUserDataDir,
} from './localPaths'

describe('getAgentDir', () => {
  it('returns agent dir by name', () => {
    expect(getAgentDir('/root', 'alice')).toBe('/root/.quimby/agents/alice')
  })
})

describe('getAgentHandoffDir', () => {
  it('returns the handoff root under agent dir', () => {
    expect(getAgentHandoffDir('/root', 'alice')).toBe('/root/.quimby/agents/alice/handoff')
  })
})

describe('getAgentHandoffInProcessedDir', () => {
  it('returns the processed-parcels dir under in/', () => {
    expect(getAgentHandoffInProcessedDir('/root', 'alice')).toBe(
      '/root/.quimby/agents/alice/handoff/in/processed',
    )
  })
})

describe('getAgentHandoffInReceivedDir', () => {
  it('returns the received-parcels scan root under in/', () => {
    expect(getAgentHandoffInReceivedDir('/root', 'alice')).toBe(
      '/root/.quimby/agents/alice/handoff/in/received',
    )
  })
})

describe('getAgentHandoffInReceivedParcelDir', () => {
  it('returns a delivered parcel dir under in/received, content-named', () => {
    expect(getAgentHandoffInReceivedParcelDir('/root', 'alice', 'bob-a1b2c3d4')).toBe(
      '/root/.quimby/agents/alice/handoff/in/received/bob-a1b2c3d4',
    )
  })
})

describe('getAgentHandoffOutDraftDir', () => {
  it('returns the unscanned authoring root under out/', () => {
    expect(getAgentHandoffOutDraftDir('/root', 'alice')).toBe(
      '/root/.quimby/agents/alice/handoff/out/draft',
    )
  })
})

describe('getAgentHandoffOutDraftRecipientDir', () => {
  it('returns an authored parcel addressed by recipient', () => {
    expect(getAgentHandoffOutDraftRecipientDir('/root', 'alice', 'bob')).toBe(
      '/root/.quimby/agents/alice/handoff/out/draft/bob',
    )
  })
})

describe('getAgentHandoffOutQueuedDir', () => {
  it('returns the queued scan root under out/', () => {
    expect(getAgentHandoffOutQueuedDir('/root', 'alice')).toBe(
      '/root/.quimby/agents/alice/handoff/out/queued',
    )
  })
})

describe('getAgentHandoffOutQueuedRecipientDir', () => {
  it('returns a queued parcel addressed by recipient', () => {
    expect(getAgentHandoffOutQueuedRecipientDir('/root', 'alice', 'bob')).toBe(
      '/root/.quimby/agents/alice/handoff/out/queued/bob',
    )
  })
})

describe('getAgentHandoffOutSentDir', () => {
  it('returns the delivery-ledger dir under out/', () => {
    expect(getAgentHandoffOutSentDir('/root', 'alice')).toBe(
      '/root/.quimby/agents/alice/handoff/out/sent',
    )
  })
})

describe('getAgentHandoffOutSentRecipientDir', () => {
  it('returns a delivered parcel in the ledger by recipient', () => {
    expect(getAgentHandoffOutSentRecipientDir('/root', 'alice', 'bob')).toBe(
      '/root/.quimby/agents/alice/handoff/out/sent/bob',
    )
  })
})

describe('getAgentRepoDir', () => {
  it('returns repo subdir of the agent dir', () => {
    expect(getAgentRepoDir('/root', 'bob')).toBe('/root/.quimby/agents/bob/repo')
  })
})

describe('getAgentsDir', () => {
  it('returns agents dir under .quimby', () => {
    expect(getAgentsDir('/root')).toBe('/root/.quimby/agents')
  })
})

describe('getAgentStatusMirrorDir', () => {
  it('returns the status-mirror dir at the agent root, outside handoff/', () => {
    expect(getAgentStatusMirrorDir('/root', 'alice')).toBe('/root/.quimby/agents/alice/status')
  })
})

describe('getProjectRegistryPath', () => {
  it('returns projects.yaml under the user config dir', () => {
    expect(getProjectRegistryPath()).toBe(`${getUserConfigDir()}/projects.yaml`)
  })
})

describe('getQuimbyDir', () => {
  it('returns .quimby under repo root', () => {
    expect(getQuimbyDir('/foo/bar')).toBe('/foo/bar/.quimby')
  })
})

describe('getStagingDir', () => {
  it('returns the staging dir under .quimby', () => {
    expect(getStagingDir('/root')).toBe('/root/.quimby/staging')
  })
})

describe('getStagingHandoffDir', () => {
  it('returns a staged parcel dir by name', () => {
    expect(getStagingHandoffDir('/root', 'alice-a1b2c3d4')).toBe(
      '/root/.quimby/staging/alice-a1b2c3d4',
    )
  })
})

describe('getStatePath', () => {
  it('returns state.yaml path', () => {
    expect(getStatePath('/root')).toBe('/root/.quimby/state.yaml')
  })
})

describe('getStorageRoot', () => {
  it('returns the durable workspace storage root under user data', () => {
    expect(getStorageRoot()).toBe(`${getUserDataDir()}/workspaces`)
  })
})

describe('getStorageWorkspaceDir', () => {
  it('returns a durable workspace dir by project id', () => {
    expect(getStorageWorkspaceDir('proj')).toBe(`${getStorageRoot()}/proj`)
  })
})

describe('getTmuxConfigPath', () => {
  it('returns the .quimby/tmux.conf path', () => {
    expect(getTmuxConfigPath('/root')).toBe('/root/.quimby/tmux.conf')
  })
})
