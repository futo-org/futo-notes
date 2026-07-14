export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  const runners: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i++) {
    runners.push(
      (async () => {
        while (true) {
          const idx = nextIndex++;
          if (idx >= items.length) return;
          await worker(items[idx], idx);
        }
      })(),
    );
  }
  await Promise.all(runners);
}
