import type { EditorGauntletAdapter } from './types';

const MIB = 1024 * 1024;

export const PERFORMANCE_BUDGET = {
  /**
   * The plan's §5 open budget is *time-to-interactive-first-viewport*. Nothing
   * here can measure that yet: progressive open is unbuilt, so the editor
   * parses and mounts the whole document before it is interactive and
   * time-to-fully-loaded is the only observable. It is an upper bound on the
   * budgeted quantity — a run that beats it has certainly beaten the budget,
   * and a run that misses it has not necessarily missed the budget. Re-point
   * this at the first-viewport milestone when there is one.
   */
  openMs: 1_000,
  keystrokeP95Ms: 16,
  /**
   * How much worse a fixture's per-unit open cost may be than its reference
   * before it counts as a cliff. The point is to catch a scaling WALL — the
   * TipTap-shaped failure, where cost jumps by an order of magnitude past some
   * size — not to police constant factors, so the multiple is generous enough
   * to absorb GC and cache effects across a 5x size step.
   */
  openCliffFactor: 2.5,
} as const;

/**
 * What a fixture's open time is held to.
 *
 * - `hard`   — must beat the open budget outright.
 * - `linear` — no absolute budget; its per-unit cost must stay within the cliff
 *              factor of `reference`, which must use the same unit and be built
 *              by the same generator.
 * - `measured` — reported only. The keystroke budget still applies; nothing
 *              gates the open time. This exists for the adversarial generator,
 *              whose documents are not shaped like real notes, so the plan's
 *              note-size budgets have nothing to say about them.
 */
export type OpenPolicy =
  { kind: 'hard' } | { kind: 'linear'; reference: string } | { kind: 'measured' };

export interface FloorFixture {
  name: string;
  /** What the per-unit cost is measured against for a linearity comparison. */
  unit: 'lines' | 'bytes';
  openPolicy: OpenPolicy;
  build(): string;
}

export interface PerformanceResult {
  fixture: string;
  lines: number;
  bytes: number;
  openMs: number;
  openSynchronousMs: number;
  keystrokeSynchronousP95Ms: number;
  keystrokeSettledToPaintP95Ms: number;
}

export type FloorViolationKind =
  'open-budget' | 'open-cliff' | 'keystroke-budget' | 'missing-reference' | 'missing-measurement';

export interface FloorViolation {
  fixture: string;
  kind: FloorViolationKind;
  detail: string;
}

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Infinity;
}

/**
 * Exported for the device floor's differential lock
 * (tests/lib/editorDevicePerf.test.mjs): the low-end-phone run must open the
 * same document this floor opens or the numbers are not comparable.
 */
export function lineFixture(lines: number): string {
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

/** The TipTap-benchmark-shaped adversarial document, grown to `targetBytes`. */
function adversarialFixture(targetBytes: number): string {
  const endMarker = `END-${Math.round(targetBytes / MIB)}MB`;
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
  blocks.push(`${endMarker}\n`);
  return blocks.join('\n');
}

/**
 * The CodeMirror ladder, unchanged: every fixture is hard-gated on open.
 * CM6 has met that bar since the bakeoff and relaxing it would only lose
 * coverage on an editor that is about to be deleted anyway.
 */
export const CM6_FLOOR_FIXTURES: FloorFixture[] = [
  ...[1_000, 10_000, 50_000].map((lines): FloorFixture => ({
    name: `${lines / 1_000}k-lines`,
    unit: 'lines',
    openPolicy: { kind: 'hard' },
    build: () => lineFixture(lines),
  })),
  {
    name: '10mb-adversarial',
    unit: 'bytes',
    openPolicy: { kind: 'hard' },
    build: () => adversarialFixture(10 * MIB),
  },
];

/**
 * The Milkdown ladder, per docs/plan/milkdown-transition.md §5: hard budgets at
 * sizes real notes actually reach, and "scales linearly, no cliff" above them.
 *
 * The size line comes from the note-size population in the plan's §2, which is
 * stated in LINES: the foreign corpus tops out at 19,295 and Justin's vault at
 * 13,876. So 1k and 10k lines are ordinary notes and get the budget, and 50k is
 * not. The adversarial fixtures get no absolute open budget at all — the
 * generator makes a document nothing in that population resembles, so the
 * plan's note-size budgets have no claim on it. It earns its place by anchoring
 * the linearity check at 10 MiB, which needs a smaller reading from the same
 * generator; per-unit cost is only comparable within one document shape.
 *
 * The keystroke budget applies everywhere: typing stays interactive at any
 * size (M5), whatever the open cost.
 */
export const MILKDOWN_FLOOR_FIXTURES: FloorFixture[] = [
  {
    name: '1000-lines',
    unit: 'lines',
    openPolicy: { kind: 'hard' },
    build: () => lineFixture(1_000),
  },
  {
    name: '10000-lines',
    unit: 'lines',
    openPolicy: { kind: 'hard' },
    build: () => lineFixture(10_000),
  },
  {
    name: '50000-lines',
    unit: 'lines',
    openPolicy: { kind: 'linear', reference: '10000-lines' },
    build: () => lineFixture(50_000),
  },
  {
    name: '1mb-adversarial',
    unit: 'bytes',
    openPolicy: { kind: 'measured' },
    build: () => adversarialFixture(MIB),
  },
  {
    name: '10mb-adversarial',
    unit: 'bytes',
    openPolicy: { kind: 'linear', reference: '1mb-adversarial' },
    build: () => adversarialFixture(10 * MIB),
  },
];

function perUnitMs(result: PerformanceResult, unit: FloorFixture['unit']): number {
  const size = unit === 'lines' ? result.lines : result.bytes;
  return size > 0 ? result.openMs / size : Infinity;
}

/** Every budget the run missed, in fixture order. Empty means the floor held. */
export function evaluatePerformanceFloor(
  fixtures: FloorFixture[],
  results: PerformanceResult[],
): FloorViolation[] {
  const byName = new Map(results.map((result) => [result.fixture, result]));
  const violations: FloorViolation[] = [];

  for (const fixture of fixtures) {
    const result = byName.get(fixture.name);
    if (!result) {
      violations.push({
        fixture: fixture.name,
        kind: 'missing-measurement',
        detail: 'the fixture produced no measurement',
      });
      continue;
    }

    if (result.keystrokeSynchronousP95Ms >= PERFORMANCE_BUDGET.keystrokeP95Ms) {
      violations.push({
        fixture: fixture.name,
        kind: 'keystroke-budget',
        detail:
          `synchronous keystroke p95 ${Math.round(result.keystrokeSynchronousP95Ms)}ms ` +
          `is not under the ${PERFORMANCE_BUDGET.keystrokeP95Ms}ms budget`,
      });
    }

    if (fixture.openPolicy.kind === 'measured') continue;

    if (fixture.openPolicy.kind === 'hard') {
      if (result.openMs >= PERFORMANCE_BUDGET.openMs) {
        violations.push({
          fixture: fixture.name,
          kind: 'open-budget',
          detail:
            `time-to-fully-loaded ${Math.round(result.openMs)}ms exceeds the ` +
            `${PERFORMANCE_BUDGET.openMs}ms open budget`,
        });
      }
      continue;
    }

    const reference = byName.get(fixture.openPolicy.reference);
    if (!reference) {
      violations.push({
        fixture: fixture.name,
        kind: 'missing-reference',
        detail: `no ${fixture.openPolicy.reference} measurement to compare against`,
      });
      continue;
    }
    const cost = perUnitMs(result, fixture.unit);
    const referenceCost = perUnitMs(reference, fixture.unit);
    const ratio = cost / referenceCost;
    if (ratio > PERFORMANCE_BUDGET.openCliffFactor) {
      violations.push({
        fixture: fixture.name,
        kind: 'open-cliff',
        detail:
          `open costs ${ratio.toFixed(1)}x as much per ${fixture.unit === 'lines' ? 'line' : 'byte'} ` +
          `as ${fixture.openPolicy.reference}, past the ${PERFORMANCE_BUDGET.openCliffFactor}x cliff factor`,
      });
    }
  }

  return violations;
}

export async function runPerformanceFloor(
  adapter: EditorGauntletAdapter,
  fixtures: FloorFixture[],
): Promise<PerformanceResult[]> {
  const results: PerformanceResult[] = [];
  await adapter.open('', 'performance-floor');
  for (const fixture of fixtures) {
    const opened = await adapter.measureOpen(fixture.build());
    const typed = await adapter.measureKeystrokes(25);
    results.push({
      fixture: fixture.name,
      lines: opened.lines,
      bytes: opened.bytes,
      openMs: opened.settledMs,
      openSynchronousMs: opened.synchronousMs,
      keystrokeSynchronousP95Ms: percentile95(typed.synchronousSamplesMs),
      keystrokeSettledToPaintP95Ms: percentile95(typed.settledToPaintSamplesMs),
    });
  }
  return results;
}
