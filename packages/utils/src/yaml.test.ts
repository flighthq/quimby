import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readYaml, writeYaml } from './yaml'

let dir: string

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-yaml-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readYaml', () => {
  it('parses a YAML file into a typed object', async () => {
    const file = join(dir, 'test.yaml')
    await writeYaml(file, { name: 'alice', count: 42 })
    const result = await readYaml<{ name: string; count: number }>(file)
    expect(result.name).toBe('alice')
    expect(result.count).toBe(42)
  })

  it('parses nested objects', async () => {
    const file = join(dir, 'nested.yaml')
    await writeYaml(file, { a: { b: { c: 'deep' } } })
    const result = await readYaml<{ a: { b: { c: string } } }>(file)
    expect(result.a.b.c).toBe('deep')
  })

  it('parses arrays', async () => {
    const file = join(dir, 'array.yaml')
    await writeYaml(file, { items: [1, 2, 3] })
    const result = await readYaml<{ items: number[] }>(file)
    expect(result.items).toEqual([1, 2, 3])
  })
})

describe('writeYaml', () => {
  it('serializes an object to a YAML file', async () => {
    const file = join(dir, 'out.yaml')
    await writeYaml(file, { key: 'value' })
    const result = await readYaml<{ key: string }>(file)
    expect(result.key).toBe('value')
  })

  it('round-trips correctly', async () => {
    const file = join(dir, 'round-trip.yaml')
    const data = {
      id: 'abc-123',
      name: 'test',
      count: 99,
      nested: { inner: true },
      list: ['a', 'b', 'c'],
    }
    await writeYaml(file, data)
    const result = await readYaml<typeof data>(file)
    expect(result).toEqual(data)
  })
})
