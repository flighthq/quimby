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
