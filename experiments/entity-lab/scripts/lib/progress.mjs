import { performance } from 'node:perf_hooks';

/**
 * Progress logger — prints elapsed time, ETA, and throughput every `interval` items.
 *
 * @param {string} label — prefix for log lines (e.g. "tag-discover")
 * @param {number} total — total items to process
 * @param {number} [interval=25] — log every N completions
 * @returns {{ tick: () => void }}
 */
export function createProgressLogger(label, total, interval = 25) {
  const startTime = performance.now();
  let done = 0;

  function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return `${m}m${rem}s`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60}m`;
  }

  function tick() {
    done++;
    if (done % interval === 0 || done === total) {
      const elapsed = performance.now() - startTime;
      const perItem = elapsed / done;
      const remaining = perItem * (total - done);
      const pct = ((done / total) * 100).toFixed(0);
      console.log(
        `[${label}] ⏱ ${pct}% (${done}/${total}) | elapsed: ${formatDuration(elapsed)} | eta: ${formatDuration(remaining)} | avg: ${Math.round(perItem)}ms/note`
      );
    }
  }

  return { tick };
}
