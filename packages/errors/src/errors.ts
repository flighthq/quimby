export class QuimbyError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message)
    this.name = 'QuimbyError'
  }
}

export class GitError extends QuimbyError {
  constructor(
    message: string,
    public stderr?: string,
  ) {
    super(message, 'GIT_ERROR')
    this.name = 'GitError'
  }
}

export class AgentError extends QuimbyError {
  constructor(
    message: string,
    public agentName?: string,
  ) {
    super(message, 'AGENT_ERROR')
    this.name = 'AgentError'
  }
}

export class HandoffError extends QuimbyError {
  constructor(
    message: string,
    public handoffName?: string,
  ) {
    super(message, 'HANDOFF_ERROR')
    this.name = 'HandoffError'
  }
}

export class SyncConflictError extends QuimbyError {
  constructor(
    message: string,
    /**
     * Whether the agent's repo is left clean and its work intact after the failed sync — true
     * only when a rebase conflict was rolled back cleanly. A caller that measures conflicts by a
     * different test (e.g. `merge`'s 3-way boundary merge, which sees only the net change) can
     * then safely proceed from the current seed; when false the repo is wedged (pre-existing
     * unmerged state, a failed abort, or a stash-pop conflict) and must be resolved first.
     */
    public agentClean: boolean,
  ) {
    super(message, 'SYNC_CONFLICT')
    this.name = 'SyncConflictError'
  }
}

export class ConflictError extends QuimbyError {
  constructor(
    message: string,
    public conflicts: string[],
    /** The staged parcel's name, so a caller can point the user at the kept staging dir. */
    public parcelName?: string,
  ) {
    super(message, 'CONFLICT')
    this.name = 'ConflictError'
  }
}
