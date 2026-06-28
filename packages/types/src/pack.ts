export interface PackMeta {
  name: string
  worker: string
  description: string
  suggestedMessage: string
  createdAt: string
  commits: CommitMeta[]
}

export interface CommitMeta {
  hash: string
  message: string
  author: string
  date: string
  patchFile: string
}
