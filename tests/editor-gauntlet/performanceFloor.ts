import type { EditorGauntletAdapter } from './types';

export const PERFORMANCE_BUDGET = {
  openMs: 1_000,
  keystrokeP95Ms: 16,
} as const;

export interface PerformanceResult {
  fixture: string;
  lines: number;
  bytes: number;
  openMs: number;
  openSynchronousMs: number;
  keystrokeSynchronousP95Ms: number;
  keystrokeSettledToPaintP95Ms: number;
  withinBudget: boolean;
}

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Infinity;
}

function lineFixture(lines: number): string {
  return Array.from({ length: lines }, (_, index) => {
    switch (index % 4) {
      case 0:
        return `paragraph ${index} with **bold** and [a link](https://example.test/${index})`;
      case 1:
        return `- list item ${index}`;
      case 2:
        return `> quoted line ${index}`;
      default:
        return `\`inline code ${index}\``;
    }
  }).join('\n');
}

function tenMegabyteFixture(): string {
  const targetBytes = 10 * 1024 * 1024;
  const blocks: string[] = [];
  let bytes = 0;
  let index = 0;
  while (bytes < targetBytes) {
    const block = [
      `## Project section ${index}`,
      '',
      `Paragraph ${index} keeps __source spelling__, a [[Project/Roadmap|wikilink]], and ` +
        `[a reference][ref-${index % 8}]. ` +
        'This sentence is intentionally ordinary prose with punctuation and Unicode café. '.repeat(
          18,
        ),
      '',
      `- [${index % 3 === 0 ? 'x' : ' '}] task ${index}`,
      `- nested-looking sibling with **strong text** and \`inline code ${index}\``,
      '',
    ].join('\n');
    blocks.push(block);
    bytes += new TextEncoder().encode(block).length;
    index += 1;
  }
  blocks.push(
    ...Array.from(
      { length: 8 },
      (_, definition) =>
        `[ref-${definition}]: https://example.com/${definition} "Reference ${definition}"\n`,
    ),
  );
  blocks.push('END-10MB\n');
  return blocks.join('\n');
}

export async function runPerformanceFloor(
  adapter: EditorGauntletAdapter,
): Promise<PerformanceResult[]> {
  const fixtures = [
    ...[1_000, 10_000, 50_000].map((lines) => ({
      name: `${lines}-lines`,
      source: lineFixture(lines),
    })),
    { name: '10mb-adversarial', source: tenMegabyteFixture() },
  ];
  const results: PerformanceResult[] = [];

  await adapter.open('', 'performance-floor');
  for (const fixture of fixtures) {
    const opened = await adapter.measureOpen(fixture.source);
    const typed = await adapter.measureKeystrokes(25);
    const keystrokeSynchronousP95Ms = percentile95(typed.synchronousSamplesMs);
    const keystrokeSettledToPaintP95Ms = percentile95(typed.settledToPaintSamplesMs);
    results.push({
      fixture: fixture.name,
      lines: opened.lines,
      bytes: opened.bytes,
      openMs: opened.settledMs,
      openSynchronousMs: opened.synchronousMs,
      keystrokeSynchronousP95Ms,
      keystrokeSettledToPaintP95Ms,
      withinBudget:
        opened.settledMs < PERFORMANCE_BUDGET.openMs &&
        keystrokeSynchronousP95Ms < PERFORMANCE_BUDGET.keystrokeP95Ms,
    });
  }
  return results;
}
