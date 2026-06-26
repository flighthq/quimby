export class AoError extends Error {
  constructor(message: string, public code?: string) {
    super(message)
    this.name = 'AoError'
  }
}

export class ConfigError extends AoError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR')
    this.name = 'ConfigError'
  }
}

export class GitError extends AoError {
  constructor(message: string, public stderr?: string) {
    super(message, 'GIT_ERROR')
    this.name = 'GitError'
  }
}

export class SandboxError extends AoError {
  constructor(message: string, public sandboxName?: string) {
    super(message, 'SANDBOX_ERROR')
    this.name = 'SandboxError'
  }
}

export class BundleError extends AoError {
  constructor(message: string, public bundleId?: string) {
    super(message, 'BUNDLE_ERROR')
    this.name = 'BundleError'
  }
}
