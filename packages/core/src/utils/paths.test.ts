import { describe, expect, it } from 'vitest'

import {
  getPackDir,
  getPacksDir,
  getQuimbyDir,
  getStatePath,
  getWorkerDir,
  getWorkerInboxDir,
  getWorkerInboxPackDir,
  getWorkerInboxStatusDir,
  getWorkerRepoDir,
  getWorkersDir,
  remotePackDir,
  remotePacksDir,
  remoteProjectRoot,
  remoteQuimbyDir,
  remoteWorkerDir,
  remoteWorkerRepoDir,
  tmuxSessionName,
} from './paths'

describe('getQuimbyDir', () => {
  it('returns .quimby under repo root', () => {
    expect(getQuimbyDir('/foo/bar')).toBe('/foo/bar/.quimby')
  })
})

describe('getStatePath', () => {
  it('returns state.yaml path', () => {
    expect(getStatePath('/root')).toBe('/root/.quimby/state.yaml')
  })
})

describe('getWorkersDir', () => {
  it('returns workers dir under .quimby', () => {
    expect(getWorkersDir('/root')).toBe('/root/.quimby/workers')
  })
})

describe('getWorkerDir', () => {
  it('returns worker dir by name', () => {
    expect(getWorkerDir('/root', 'alice')).toBe('/root/.quimby/workers/alice')
  })
})

describe('getWorkerRepoDir', () => {
  it('returns repo subdir of the worker dir', () => {
    expect(getWorkerRepoDir('/root', 'bob')).toBe('/root/.quimby/workers/bob/repo')
  })
})

describe('getPacksDir', () => {
  it('returns packs dir under .quimby', () => {
    expect(getPacksDir('/root')).toBe('/root/.quimby/packs')
  })
})

describe('getPackDir', () => {
  it('returns pack dir by name', () => {
    expect(getPackDir('/root', 'alice-1')).toBe('/root/.quimby/packs/alice-1')
  })
})

describe('getWorkerInboxDir', () => {
  it('returns inbox dir under worker dir', () => {
    expect(getWorkerInboxDir('/root', 'alice')).toBe('/root/.quimby/workers/alice/inbox')
  })
})

describe('getWorkerInboxPackDir', () => {
  it('returns inbox packs dir for a specific pack', () => {
    expect(getWorkerInboxPackDir('/root', 'alice', 'bob-1')).toBe(
      '/root/.quimby/workers/alice/inbox/packs/bob-1',
    )
  })
})

describe('getWorkerInboxStatusDir', () => {
  it('returns inbox status dir under worker dir', () => {
    expect(getWorkerInboxStatusDir('/root', 'alice')).toBe(
      '/root/.quimby/workers/alice/inbox/status',
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

describe('remoteWorkerDir', () => {
  it('returns remote worker dir with worker name', () => {
    expect(remoteWorkerDir('proj-id', 'alice')).toBe(
      '~/.quimby/workspaces/proj-id/.quimby/workers/alice',
    )
  })

  it('uses base override', () => {
    expect(remoteWorkerDir('proj-id', 'alice', '/base')).toBe('/base/.quimby/workers/alice')
  })
})

describe('remoteWorkerRepoDir', () => {
  it('returns repo subdir of remote worker dir', () => {
    expect(remoteWorkerRepoDir('proj-id', 'alice')).toBe(
      '~/.quimby/workspaces/proj-id/.quimby/workers/alice/repo',
    )
  })

  it('uses base override', () => {
    expect(remoteWorkerRepoDir('proj-id', 'alice', '/base')).toBe(
      '/base/.quimby/workers/alice/repo',
    )
  })
})

describe('remotePacksDir', () => {
  it('returns remote packs dir', () => {
    expect(remotePacksDir('proj-id')).toBe('~/.quimby/workspaces/proj-id/.quimby/packs')
  })

  it('uses base override', () => {
    expect(remotePacksDir('proj-id', '/base')).toBe('/base/.quimby/packs')
  })
})

describe('remotePackDir', () => {
  it('returns remote pack dir by name', () => {
    expect(remotePackDir('proj-id', 'alice-1')).toBe(
      '~/.quimby/workspaces/proj-id/.quimby/packs/alice-1',
    )
  })

  it('uses base override', () => {
    expect(remotePackDir('proj-id', 'alice-1', '/base')).toBe('/base/.quimby/packs/alice-1')
  })
})

describe('tmuxSessionName', () => {
  it('returns qb-<first8>-<first8> format', () => {
    const projectId = 'abcdef12-1234-5678-9abc-def012345678'
    const workerId = '98765432-abcd-ef01-2345-6789abcdef01'
    expect(tmuxSessionName(projectId, workerId)).toBe('qb-abcdef12-98765432')
  })

  it('truncates UUIDs to 8 characters', () => {
    const result = tmuxSessionName('aabbccdd-xxxx', 'eeffgghh-yyyy')
    expect(result).toBe('qb-aabbccdd-eeffgghh')
  })
})
