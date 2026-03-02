/**
 * Simple concurrent worker pool.
 * N workers pull from a shared index — JS single-threaded so index++
 * between awaits is safe. Per-item errors are caught and don't kill the pool.
 *
 * @param {Array} items
 * @param {(item: any, index: number) => Promise<void>} fn
 * @param {number} concurrency
 * @returns {Promise<void>}
 */
export async function runConcurrent(items, fn, concurrency) {
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        await fn(items[i], i);
      } catch (err) {
        // Per-item errors are handled by the caller's fn.
        // This catch prevents one failure from killing the pool.
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}
