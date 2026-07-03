import { QuimbyError } from '@quimbyhq/errors'

export interface ParsedCommand {
  command: string
  args: string[]
}

export function parseCommand(input: string): ParsedCommand {
  const parts = splitCommand(input)
  if (parts.length === 0) throw new QuimbyError('Entrypoint command cannot be empty')
  return { command: parts[0], args: parts.slice(1) }
}

export function splitCommand(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const c of input.trim()) {
    if (escaping) {
      cur += c
      escaping = false
      continue
    }
    if (c === '\\' && quote !== "'") {
      escaping = true
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (/\s/.test(c)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += c
  }

  if (escaping) cur += '\\'
  if (quote) throw new QuimbyError('Entrypoint command has an unterminated quote')
  if (cur) out.push(cur)
  return out
}
