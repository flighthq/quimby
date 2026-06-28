import { readFile, writeFile } from 'node:fs/promises'

import { parse, stringify } from 'yaml'

export async function readYaml<T>(path: string): Promise<T> {
  const content = await readFile(path, 'utf-8')
  return parse(content) as T
}

export async function writeYaml(path: string, data: unknown): Promise<void> {
  const content = stringify(data, { lineWidth: 0 })
  await writeFile(path, content, 'utf-8')
}
