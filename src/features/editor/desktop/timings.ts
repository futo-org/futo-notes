/* Our own work per keystroke: the input handler plus the caret draw that follows it.
 * The budget (docs/plan/desktop-editor.md) is a median under 1 ms and p99 under 2 ms;
 * Puppet reads the summary. */
const KEPT = 2000;

export interface TimingSummary {
  count: number;
  median: number;
  p99: number;
  max: number;
}

export class KeystrokeTimings {
  private readonly samples: number[] = [];
  private pendingCaret = false;

  input(milliseconds: number): void {
    this.samples.push(milliseconds);
    if (this.samples.length > KEPT) this.samples.shift();
    this.pendingCaret = true;
  }

  /** The caret draw after an input counts toward that input. */
  caret(milliseconds: number): void {
    if (!this.pendingCaret) return;
    this.pendingCaret = false;
    this.samples[this.samples.length - 1] += milliseconds;
  }

  summary(): TimingSummary {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (fraction: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] : 0;
    return {
      count: sorted.length,
      median: at(0.5),
      p99: at(0.99),
      max: sorted[sorted.length - 1] ?? 0,
    };
  }

  clear(): void {
    this.samples.length = 0;
    this.pendingCaret = false;
  }
}
