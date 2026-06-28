import { describe, expect, it } from 'vitest'

import { logger } from './logger'

describe('logger', () => {
  it('is defined', () => {
    expect(logger).toBeDefined()
  })

  it('has standard logging methods', () => {
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
  })

  it('has the quimby tag', () => {
    // consola v3 stores the tag in options.defaults.tag
    const tag = (logger as unknown as { options: { defaults: { tag?: string } } }).options?.defaults
      ?.tag
    expect(tag).toBe('quimby')
  })
})
