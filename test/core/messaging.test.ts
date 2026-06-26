import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { sendMessage, listMessages, parseMessage, serializeMessage } from '../../src/core/messaging.js'
import { LocalTransport } from '../../src/core/transport/local.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-msg-test-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('serializeMessage', () => {
  it('serializes a message to frontmatter + body', () => {
    const msg = {
      id: '001',
      from: 'frontend',
      to: 'backend',
      type: 'question' as const,
      subject: 'API contract',
      body: 'What format should the response be?',
      createdAt: '2024-01-01T00:00:00Z',
      priority: 'normal' as const,
    }
    const serialized = serializeMessage(msg)
    expect(serialized).toContain('---')
    expect(serialized).toContain('from: frontend')
    expect(serialized).toContain('What format should the response be?')
  })
})

describe('parseMessage', () => {
  it('parses a serialized message', () => {
    const original = {
      id: '002',
      from: 'reviewer',
      to: 'builder',
      type: 'feedback' as const,
      subject: 'Error handling',
      body: 'The error handling needs work.\n\nPlease add try/catch blocks.',
      createdAt: '2024-01-01T00:00:00Z',
      priority: 'high' as const,
    }
    const serialized = serializeMessage(original)
    const parsed = parseMessage(serialized)
    expect(parsed.id).toBe('002')
    expect(parsed.from).toBe('reviewer')
    expect(parsed.type).toBe('feedback')
    expect(parsed.body).toContain('error handling needs work')
  })

  it('throws on invalid format', () => {
    expect(() => parseMessage('no frontmatter here')).toThrow('missing frontmatter')
  })
})

describe('sendMessage', () => {
  it('delivers a message to the recipient sandbox', async () => {
    const toDir = join(tmp, 'recipient')
    await mkdir(toDir, { recursive: true })

    const fromTransport = new LocalTransport(join(tmp, 'sender'))
    const toTransport = new LocalTransport(toDir)

    const msg = await sendMessage({
      fromTransport,
      toTransport,
      from: 'frontend',
      to: 'backend',
      type: 'question',
      subject: 'API types',
      body: 'Should we use zod for validation?',
    })

    expect(msg.id).toBe('001')
    expect(msg.from).toBe('frontend')
    expect(msg.to).toBe('backend')

    const delivered = await toTransport.exists('.sandbox/messages/from-frontend/001.md')
    expect(delivered).toBe(true)
  })

  it('increments message IDs', async () => {
    const toDir = join(tmp, 'recipient2')
    await mkdir(toDir, { recursive: true })

    const fromTransport = new LocalTransport(join(tmp, 'sender2'))
    const toTransport = new LocalTransport(toDir)

    const msg1 = await sendMessage({
      fromTransport,
      toTransport,
      from: 'a',
      to: 'b',
      type: 'question',
      subject: 'first',
      body: 'first message',
    })

    const msg2 = await sendMessage({
      fromTransport,
      toTransport,
      from: 'a',
      to: 'b',
      type: 'feedback',
      subject: 'second',
      body: 'second message',
    })

    expect(msg1.id).toBe('001')
    expect(msg2.id).toBe('002')
  })
})

describe('listMessages', () => {
  it('returns empty array when no messages', async () => {
    const dir = join(tmp, 'empty')
    await mkdir(dir, { recursive: true })
    const transport = new LocalTransport(dir)
    const msgs = await listMessages(transport)
    expect(msgs).toEqual([])
  })

  it('lists all messages from all senders', async () => {
    const dir = join(tmp, 'multi')
    await mkdir(dir, { recursive: true })

    const fromA = new LocalTransport(join(tmp, 'a'))
    const fromB = new LocalTransport(join(tmp, 'b'))
    const toTransport = new LocalTransport(dir)

    await sendMessage({
      fromTransport: fromA,
      toTransport,
      from: 'alpha',
      to: 'target',
      type: 'question',
      subject: 'q1',
      body: 'from alpha',
    })

    await sendMessage({
      fromTransport: fromB,
      toTransport,
      from: 'beta',
      to: 'target',
      type: 'blocker',
      subject: 'b1',
      body: 'from beta',
    })

    const msgs = await listMessages(toTransport)
    expect(msgs).toHaveLength(2)
    const senders = msgs.map((m) => m.from).sort()
    expect(senders).toEqual(['alpha', 'beta'])
  })

  it('filters by sender', async () => {
    const dir = join(tmp, 'filtered')
    await mkdir(dir, { recursive: true })

    const fromA = new LocalTransport(join(tmp, 'fa'))
    const toTransport = new LocalTransport(dir)

    await sendMessage({
      fromTransport: fromA,
      toTransport,
      from: 'specific',
      to: 'target',
      type: 'feedback',
      subject: 'f1',
      body: 'specific feedback',
    })

    const msgs = await listMessages(toTransport, { from: 'specific' })
    expect(msgs).toHaveLength(1)
    expect(msgs[0].from).toBe('specific')

    const empty = await listMessages(toTransport, { from: 'other' })
    expect(empty).toHaveLength(0)
  })
})
