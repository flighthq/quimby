import { describe, expect, it } from 'vitest'

import { mapConcurrentInOrder } from './concurrency'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
