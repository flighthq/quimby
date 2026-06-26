export interface BundleMeta {
  id: string
  sandbox: string
  description: string
  suggestedMessage: string
  createdAt: string
  commits: CommitMeta[]
  dependencies?: string[]
}

export interface CommitMeta {
  hash: string
  message: string
  author: string
  date: string
  patchFile: string
}
