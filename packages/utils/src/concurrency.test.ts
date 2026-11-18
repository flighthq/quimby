import { describe, expect, it } from 'vitest'

import { mapConcurrentAsCompleted, mapConcurrentInOrder } from './concurrency'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('mapConcurrentAsCompleted', () => {
  it('emits each result as it finishes, so one slow item holds nothing back', async () => {
    const order: number[] = []
    const out = await mapConcurrentAsCompleted(
      [40, 5, 10],
      3,
      async (ms) => {
        await sleep(ms)
        return ms
      },
      (ms) => void order.push(ms),
    )
    expect(order).toEqual([5, 10, 40])
    // The returned array is still in input order.
    expect(out).toEqual([40, 5, 10])
  })

  it('serializes emits even when they are async', async () => {
    const log: string[] = []
    await mapConcurrentAsCompleted(
      [1, 2],
      2,
      async (n) => n,
      async (n) => {
        log.push(`start ${n}`)
        await sleep(5)
        log.push(`end ${n}`)
      },
    )
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
  })
})

describe('mapConcurrentInOrder', () => {
  it('emits in input order even when later items finish first', async () => {
    const order: number[] = []
    const out = await mapConcurrentInOrder(
      [30, 5, 10, 1],
      4,
      async (ms) => {
        await sleep(ms)
        return ms * 2
      },
      (result) => void order.push(result),
    )
    expect(order).toEqual([60, 10, 20, 2])
    expect(out).toEqual([60, 10, 20, 2])
  })

  it('emits the first result before the slowest item finishes', async () => {
    const events: string[] = []
    await mapConcurrentInOrder(
      [1, 50],
      2,
      async (ms) => {
        await sleep(ms)
        events.push(`done ${ms}`)
        return ms
      },
      (ms) => void events.push(`emit ${ms}`),
    )
    expect(events.indexOf('emit 1')).toBeLessThan(events.indexOf('done 50'))
  })

  it('never runs more than the limit at once', async () => {
    let running = 0
    let peak = 0
    await mapConcurrentInOrder(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        peak = Math.max(peak, ++running)
        await sleep(2)
        running--
      },
      () => {},
    )
    expect(peak).toBe(3)
  })

  it('handles an empty list', async () => {
    expect(
      await mapConcurrentInOrder(
        [],
        3,
        async () => 1,
        () => {},
      ),
    ).toEqual([])
  })
})
