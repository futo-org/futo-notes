/**
 * Typing latency measurement for CodeMirror 6.
 *
 * Measures the time from `beforeinput` (browser fires the input event)
 * to the next `requestAnimationFrame` after CM dispatches the resulting
 * transaction. This captures the full JS + layout + paint pipeline per
 * keystroke.
 *
 * Results are logged to the console and accumulated in a histogram
 * accessible via `window.__typingLatency` in dev mode.
 *
 * Usage: add `typingLatencyExtension()` to the CM6 extensions array.
 */

import { EditorView, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

// ── Histogram ────────────────────────────────────────────────────

const BUCKET_BOUNDARIES = [2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 256];

interface LatencyHistogram {
  samples: number[];
  buckets: number[];         // count per bucket
  boundaries: number[];      // upper bound of each bucket (ms)
  count: number;
  sum: number;
  min: number;
  max: number;
}

function createHistogram(): LatencyHistogram {
  return {
    samples: [],
    buckets: new Array(BUCKET_BOUNDARIES.length + 1).fill(0),
    boundaries: BUCKET_BOUNDARIES,
    count: 0,
    sum: 0,
    min: Infinity,
    max: 0,
  };
}

function recordSample(h: LatencyHistogram, ms: number): void {
  h.samples.push(ms);
  h.count++;
  h.sum += ms;
  if (ms < h.min) h.min = ms;
  if (ms > h.max) h.max = ms;

  // Find bucket
  let i = 0;
  while (i < BUCKET_BOUNDARIES.length && ms > BUCKET_BOUNDARIES[i]) i++;
  h.buckets[i]++;
}

function percentile(h: LatencyHistogram, p: number): number {
  if (h.samples.length === 0) return 0;
  const sorted = [...h.samples].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Public API (exposed on window in dev mode) ───────────────────

export interface TypingLatencyStats {
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface TypingLatencyAPI {
  stats(): TypingLatencyStats;
  histogram(): string;
  reset(): void;
  samples: number[];
}

function buildAPI(h: LatencyHistogram): TypingLatencyAPI {
  return {
    stats(): TypingLatencyStats {
      return {
        count: h.count,
        mean: h.count > 0 ? h.sum / h.count : 0,
        min: h.count > 0 ? h.min : 0,
        max: h.max,
        p50: percentile(h, 50),
        p95: percentile(h, 95),
        p99: percentile(h, 99),
      };
    },

    histogram(): string {
      if (h.count === 0) return '(no samples)';
      const lines: string[] = [];
      const maxCount = Math.max(...h.buckets);
      const barWidth = 40;

      for (let i = 0; i <= BUCKET_BOUNDARIES.length; i++) {
        const lo = i === 0 ? 0 : BUCKET_BOUNDARIES[i - 1];
        const hi = i < BUCKET_BOUNDARIES.length ? BUCKET_BOUNDARIES[i] : Infinity;
        const label = hi === Infinity ? `>${lo}ms` : `${lo}-${hi}ms`;
        const count = h.buckets[i];
        const bar = maxCount > 0 ? '█'.repeat(Math.round((count / maxCount) * barWidth)) : '';
        const pct = h.count > 0 ? ((count / h.count) * 100).toFixed(1) : '0.0';
        lines.push(`${label.padStart(10)} │ ${bar.padEnd(barWidth)} ${String(count).padStart(5)} (${pct}%)`);
      }

      const s = this.stats();
      lines.push('');
      lines.push(`  n=${s.count}  mean=${s.mean.toFixed(1)}ms  p50=${s.p50.toFixed(1)}ms  p95=${s.p95.toFixed(1)}ms  p99=${s.p99.toFixed(1)}ms  max=${s.max.toFixed(1)}ms`);
      return lines.join('\n');
    },

    reset(): void {
      h.samples.length = 0;
      h.buckets.fill(0);
      h.count = 0;
      h.sum = 0;
      h.min = Infinity;
      h.max = 0;
    },

    get samples() { return h.samples; },
  };
}

// ── CM6 Extension ────────────────────────────────────────────────

const LOG_THRESHOLD = 32; // only log individual keystrokes over this (ms)
const SUMMARY_INTERVAL = 50; // print summary every N keystrokes

export function typingLatencyExtension(): Extension[] {
  const hist = createHistogram();
  let inputTime = 0;
  let pendingMeasure = false;

  // Expose API on window
  if (typeof window !== 'undefined') {
    (window as any).__typingLatency = buildAPI(hist);
  }

  const domHandlers = EditorView.domEventHandlers({
    beforeinput() {
      inputTime = performance.now();
      pendingMeasure = true;
      return false; // don't consume
    },
  });

  const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
    if (!pendingMeasure || !update.docChanged || inputTime === 0) return;
    pendingMeasure = false;

    const capturedInputTime = inputTime;
    inputTime = 0;

    // Schedule measurement after CM's update cycle, at the next paint
    requestAnimationFrame(() => {
      const paintTime = performance.now();
      const latency = paintTime - capturedInputTime;

      recordSample(hist, latency);

      if (latency > LOG_THRESHOLD) {
        console.warn(`[TYPING] ${latency.toFixed(1)}ms (keystroke ${hist.count})`);
      }

      if (hist.count > 0 && hist.count % SUMMARY_INTERVAL === 0) {
        const s = buildAPI(hist).stats();
        console.log(`[TYPING] ${hist.count} keystrokes — mean=${s.mean.toFixed(1)}ms p50=${s.p50.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms p99=${s.p99.toFixed(1)}ms max=${s.max.toFixed(1)}ms`);
      }
    });
  });

  return [domHandlers, updateListener];
}
