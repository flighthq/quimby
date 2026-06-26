export type MessageType = 'question' | 'feedback' | 'blocker'

export interface Message {
  id: string
  from: string
  to: string
  type: MessageType
  subject: string
  body: string
  createdAt: string
  references?: string[]
  priority?: 'low' | 'normal' | 'high'
}
