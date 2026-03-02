import { writeJsonFile } from './fs-utils.mjs';

/**
 * Periodic cache flusher — writes cache to disk every `interval` ticks
 * to limit data loss on crash. Guards against stacked writes.
 *
 * @param {object} cache — mutable cache object (written as-is)
 * @param {string} filePath — output file path
 * @param {number} [interval=10] — flush every N ticks
 * @returns {{ tick: () => void, flush: () => Promise<void> }}
 */
export function createCacheFlusher(cache, filePath, interval = 10) {
  let count = 0;
  let pendingWrite = null;

  async function doWrite() {
    cache.updatedAt = new Date().toISOString();
    await writeJsonFile(filePath, cache);
  }

  /**
   * Final flush — waits for any in-flight periodic write, then writes
   * again to capture all mutations since the last write.
   */
  async function flush() {
    if (pendingWrite) {
      await pendingWrite.catch(() => {});
    }
    await doWrite();
  }

  function tick() {
    count++;
    if (count % interval === 0 && !pendingWrite) {
      pendingWrite = doWrite()
        .catch(() => {})
        .finally(() => { pendingWrite = null; });
    }
  }

  return { tick, flush };
}
