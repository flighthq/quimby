import { describe, expect, it } from 'vitest'

import { collectingReporter, silentReporter } from './reporter'

describe('collectingReporter', () => {
  it('records each call in order with its level and message', () => {
    const { reporter, events } = collectingReporter()

    reporter.start('cloning')
    reporter.warn('recipient unknown')
    reporter.success('done')
    reporter.info('nothing to do')
    reporter.error('boom')

    expect(events).toEqual([
      { level: 'start', message: 'cloning' },
      { level: 'warn', message: 'recipient unknown' },
      { level: 'success', message: 'done' },
      { level: 'info', message: 'nothing to do' },
      { level: 'error', message: 'boom' },
    ])
  })

  it('starts with no events and exposes the same array it mutates', () => {
    const { reporter, events } = collectingReporter()
    expect(events).toEqual([])
    reporter.info('first')
    expect(events).toHaveLength(1)
  })
})

describe('silentReporter', () => {
  it('accepts every level without throwing and records nothing', () => {
    expect(() => {
      silentReporter.start('x')
      silentReporter.success('x')
      silentReporter.info('x')
      silentReporter.warn('x')
      silentReporter.error('x')
    }).not.toThrow()
  })
})
