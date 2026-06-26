import { join } from 'pathe'
import { parse, stringify } from 'yaml'
import type { SandboxTransport } from './transport/types.js'
import type { Message, MessageType } from '../types/message.js'

function serializeMessage(msg: Message): string {
  const { body, ...frontmatter } = msg
  return `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}\n`
}

function parseMessage(content: string): Message {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/)
  if (!fmMatch) {
    throw new Error('Invalid message format: missing frontmatter')
  }
  const frontmatter = parse(fmMatch[1]) as Omit<Message, 'body'>
  const body = fmMatch[2].trimEnd()
  return { ...frontmatter, body }
}

function nextMessageId(existing: string[]): string {
  const nums = existing
    .map((name) => {
      const match = name.match(/^(\d+)\.md$/)
      return match ? parseInt(match[1], 10) : 0
    })
    .filter(Boolean)
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1
  return String(next).padStart(3, '0')
}

export async function sendMessage(opts: {
  fromTransport: SandboxTransport
  toTransport: SandboxTransport
  from: string
  to: string
  type: MessageType
  subject: string
  body: string
  references?: string[]
  priority?: Message['priority']
}): Promise<Message> {
  const { toTransport, from, to, type, subject, body, references, priority } = opts

  const inboxDir = `.sandbox/messages/from-${from}`
  await toTransport.ensureDir(inboxDir)

  const existing = await toTransport.listDir(inboxDir)
  const id = nextMessageId(existing)

  const message: Message = {
    id,
    from,
    to,
    type,
    subject,
    body,
    createdAt: new Date().toISOString(),
    references,
    priority: priority ?? 'normal',
  }

  await toTransport.pushFile(
    join(inboxDir, `${id}.md`),
    serializeMessage(message),
  )

  return message
}

export async function listMessages(
  transport: SandboxTransport,
  opts?: { from?: string },
): Promise<Message[]> {
  const messagesDir = '.sandbox/messages'
  if (!(await transport.exists(messagesDir))) return []

  const dirs = await transport.listDir(messagesDir)
  const fromDirs = dirs.filter((d) => d.startsWith('from-'))

  if (opts?.from) {
    const target = `from-${opts.from}`
    if (!fromDirs.includes(target)) return []
    return readMessagesFromDir(transport, join(messagesDir, target))
  }

  const messages: Message[] = []
  for (const dir of fromDirs) {
    const dirMessages = await readMessagesFromDir(
      transport,
      join(messagesDir, dir),
    )
    messages.push(...dirMessages)
  }

  return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

async function readMessagesFromDir(
  transport: SandboxTransport,
  dirPath: string,
): Promise<Message[]> {
  const files = await transport.listDir(dirPath)
  const mdFiles = files.filter((f) => f.endsWith('.md')).sort()

  const messages: Message[] = []
  for (const file of mdFiles) {
    try {
      const content = await transport.pullFile(join(dirPath, file))
      messages.push(parseMessage(content))
    } catch {
      // skip malformed messages
    }
  }
  return messages
}

export { parseMessage, serializeMessage }
