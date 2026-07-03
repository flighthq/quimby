import { describe, expect, it } from 'vitest'

import { parseCommand, splitCommand } from './command'

describe('parseCommand', () => {
  it('returns the command and argv separately', () => {
    expect(parseCommand('codex --model "gpt 5"')).toEqual({
      command: 'codex',
      args: ['--model', 'gpt 5'],
    })
  })

  it('rejects an empty entrypoint', () => {
    expect(() => parseCommand('   ')).toThrow('cannot be empty')
  })
})

describe('splitCommand', () => {
  it('splits whitespace-delimited command parts', () => {
    expect(splitCommand('claude --resume')).toEqual(['claude', '--resume'])
  })

  it('preserves double-quoted arguments', () => {
    expect(splitCommand('codex --model "gpt 5"')).toEqual(['codex', '--model', 'gpt 5'])
  })

  it('preserves single-quoted arguments', () => {
    expect(splitCommand("node -e 'console.log(1)'")).toEqual(['node', '-e', 'console.log(1)'])
  })

  it('supports backslash escaping outside single quotes', () => {
    expect(splitCommand('cmd one\\ two "three \\"four\\""')).toEqual([
      'cmd',
      'one two',
      'three "four"',
    ])
  })

  it('throws on unterminated quotes', () => {
    expect(() => splitCommand('codex "oops')).toThrow('unterminated quote')
  })
})
