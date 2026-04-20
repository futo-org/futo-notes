/**
 * Pull-driven bounded-concurrency pool. `worker` is invoked once per
 * item; `concurrency` workers race to claim the next index. Errors in a
 * worker reject the outer promise — callers that need per-item error
 * handling should try/catch inside `worker`.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  const runners: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i++) {
    runners.push((async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= items.length) return;
        await worker(items[idx], idx);
      }
    })());
  }
  await Promise.all(runners);
}
