import { describe, expect, it } from 'vitest'

import {
  getAgentDir,
  getAgentInboxDir,
  getAgentInboxDoneDir,
  getAgentInboxParcelDir,
  getAgentInboxStatusDir,
  getAgentOutboxDir,
  getAgentOutboxDraftDir,
  getAgentOutboxSentDir,
  getAgentOutboxSentDraftDir,
  getAgentRepoDir,
  getAgentsDir,
  getQuimbyDir,
  getStagingDir,
  getStagingHandoffDir,
  getStatePath,
} from './localPaths'

describe('getAgentDir', () => {
  it('returns agent dir by name', () => {
    expect(getAgentDir('/root', 'alice')).toBe('/root/.quimby/agents/alice')
  })
})

describe('getAgentInboxDir', () => {
  it('returns inbox dir under agent dir', () => {
    expect(getAgentInboxDir('/root', 'alice')).toBe('/root/.quimby/agents/alice/inbox')
  })
})

describe('getAgentInboxDoneDir', () => {
  it('returns the processed-parcels dir under inbox', () => {
    expect(getAgentInboxDoneDir('/root', 'alice')).toBe('/root/.quimby/agents/alice/inbox/.done')
  })
})

describe('getAgentInboxParcelDir', () => {
  it('returns a delivered parcel dir directly under inbox', () => {
    expect(getAgentInboxParcelDir('/root', 'alice', 'bob-a1b2c3d4')).toBe(
      '/root/.quimby/agents/alice/inbox/bob-a1b2c3d4',
    )
  })
})

describe('getAgentInboxStatusDir', () => {
  it('returns inbox status dir under agent dir', () => {
    expect(getAgentInboxStatusDir('/root', 'alice')).toBe('/root/.quimby/agents/alice/inbox/status')
  })
})

describe('getAgentOutboxDir', () => {
  it('returns outbox dir under agent dir', () => {
    expect(getAgentOutboxDir('/root', 'alice')).toBe('/root/.quimby/agents/alice/outbox')
  })
})

describe('getAgentOutboxDraftDir', () => {
  it('returns a staged outbox parcel addressed by recipient', () => {
    expect(getAgentOutboxDraftDir('/root', 'alice', 'bob')).toBe(
      '/root/.quimby/agents/alice/outbox/bob',
    )
  })
})

describe('getAgentOutboxSentDir', () => {
  it('returns the delivery ledger dir under outbox', () => {
    expect(getAgentOutboxSentDir('/root', 'alice')).toBe('/root/.quimby/agents/alice/outbox/.sent')
  })
})

describe('getAgentOutboxSentDraftDir', () => {
  it('returns a delivered parcel in the ledger by recipient', () => {
    expect(getAgentOutboxSentDraftDir('/root', 'alice', 'bob')).toBe(
      '/root/.quimby/agents/alice/outbox/.sent/bob',
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
