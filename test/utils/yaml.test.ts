import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { readYaml, writeYaml } from '../../src/utils/yaml.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-test-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('writeYaml', () => {
  it('writes an object as YAML', async () => {
    const file = join(tmp, 'test.yaml')
    await writeYaml(file, { name: 'test', count: 42 })
    const content = await readYaml<{ name: string; count: number }>(file)
    expect(content.name).toBe('test')
    expect(content.count).toBe(42)
  })
})

describe('readYaml', () => {
  it('reads and parses a YAML file', async () => {
    const file = join(tmp, 'read.yaml')
    await writeYaml(file, { items: ['a', 'b'], nested: { key: 'val' } })
    const result = await readYaml<{ items: string[]; nested: { key: string } }>(file)
    expect(result.items).toEqual(['a', 'b'])
    expect(result.nested.key).toBe('val')
  })
})
