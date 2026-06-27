export class QuimbyError extends Error {
  constructor(message: string, public code?: string) {
    super(message)
    this.name = 'QuimbyError'
  }
}

export class GitError extends QuimbyError {
  constructor(message: string, public stderr?: string) {
    super(message, 'GIT_ERROR')
    this.name = 'GitError'
  }
}

export class WorkerError extends QuimbyError {
  constructor(message: string, public workerName?: string) {
    super(message, 'WORKER_ERROR')
    this.name = 'WorkerError'
  }
}

export class PackError extends QuimbyError {
  constructor(message: string, public packName?: string) {
    super(message, 'PACK_ERROR')
    this.name = 'PackError'
  }
}
