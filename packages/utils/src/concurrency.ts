/**
 * Run `fn` over `items` with at most `limit` in flight, handing each result to `emit` in INPUT
 * order as soon as it and everything before it are done. For listings that should stream: the
 * first row prints when the first item finishes, not when the slowest one does, and the output
 * order never depends on which finished first.
 */
export async function mapConcurrentInOrder<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  emit: (result: R, item: T, index: number) => void | Promise<void>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const done = new Array<boolean>(items.length).fill(false)
  let next = 0
  let emitted = 0
  let emitting: Promise<void> = Promise.resolve()

  const flush = (): Promise<void> => {
    emitting = emitting.then(async () => {
      while (emitted < items.length && done[emitted]) {
        await emit(results[emitted], items[emitted], emitted)
        emitted++
      }
    })
    return emitting
  }

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
      done[index] = true
      await flush()
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  await flush()
  return results
}
